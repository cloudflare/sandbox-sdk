import {
  SESSIONLESS_SESSION_ID,
  type ExecEvent,
  type ExecResult,
  type ListFilesResult,
  type SessionCreateResult
} from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseSSEStream } from '../../packages/sandbox/src/sse-parser';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

async function setDefaultSessionPolicy(
  workerUrl: string,
  headers: Record<string, string>,
  enableDefaultSession: boolean
): Promise<void> {
  const response = await fetch(`${workerUrl}/api/session/default-policy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ enableDefaultSession })
  });

  expect(response.status).toBe(200);
}

async function executeCommand(
  workerUrl: string,
  headers: Record<string, string>,
  command: string
): Promise<ExecResult> {
  const response = await fetch(`${workerUrl}/api/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command })
  });

  expect(response.status).toBe(200);
  return (await response.json()) as ExecResult;
}

async function collectStreamEvents(response: Response): Promise<ExecEvent[]> {
  if (!response.body) {
    throw new Error('No readable stream in response');
  }

  const events: ExecEvent[] = [];
  const abortController = new AbortController();

  try {
    for await (const event of parseSSEStream<ExecEvent>(
      response.body,
      abortController.signal
    )) {
      events.push(event);
      if (event.type === 'complete' || event.type === 'error') {
        abortController.abort();
        break;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message !== 'Operation was aborted') {
      throw error;
    }
  }

  return events;
}

describe('Sessionless Execution Workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should run implicit exec calls without shared shell state when default sessions are disabled', async () => {
    await setDefaultSessionPolicy(workerUrl, headers, false);

    const testDir = sandbox!.uniquePath('sessionless-state');
    const first = await executeCommand(
      workerUrl,
      headers,
      `mkdir -p '${testDir}' && export SESSIONLESS_MARKER=present && cd '${testDir}' && printf '%s|%s' "$SESSIONLESS_MARKER" "$PWD"`
    );

    expect(first.success).toBe(true);
    expect(first.stdout.trim()).toBe(`present|${testDir}`);

    const second = await executeCommand(
      workerUrl,
      headers,
      `printf '%s|%s' "\${SESSIONLESS_MARKER:-missing}" "$PWD"`
    );

    expect(second.success).toBe(true);
    const [marker, cwd] = second.stdout.trim().split('|');
    expect(marker).toBe('missing');
    expect(cwd).not.toBe(testDir);

    await setDefaultSessionPolicy(workerUrl, headers, true);
  }, 90000);

  test('should let execStream opt into sessionless execution without disturbing the default session', async () => {
    await setDefaultSessionPolicy(workerUrl, headers, true);

    const before = await executeCommand(
      workerUrl,
      headers,
      `export SESSIONLESS_OVERRIDE_MARKER=default-session-value && printf '%s' "$SESSIONLESS_OVERRIDE_MARKER"`
    );
    expect(before.success).toBe(true);
    expect(before.stdout).toBe('default-session-value');

    const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `printf '%s' "\${SESSIONLESS_OVERRIDE_MARKER:-missing}"`,
        sessionId: SESSIONLESS_SESSION_ID
      })
    });
    expect(streamResponse.status).toBe(200);

    const events = await collectStreamEvents(streamResponse);
    const stdout = events
      .filter((event) => event.type === 'stdout')
      .map((event) => event.data ?? '')
      .join('');
    const complete = events.find((event) => event.type === 'complete');
    const error = events.find((event) => event.type === 'error');

    expect(stdout).toBe('missing');
    expect(complete).toBeDefined();
    expect(error).toBeUndefined();

    const after = await executeCommand(
      workerUrl,
      headers,
      `printf '%s' "$SESSIONLESS_OVERRIDE_MARKER"`
    );
    expect(after.success).toBe(true);
    expect(after.stdout).toBe('default-session-value');
  }, 90000);

  test('should resolve relative listFiles paths using the explicit sessionId option', async () => {
    const testDir = sandbox!.uniquePath('session-list-files');
    const filePath = `${testDir}/session-only.txt`;

    const mkdirResponse = await fetch(`${workerUrl}/api/file/mkdir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: testDir, recursive: true })
    });
    expect(mkdirResponse.status).toBe(200);

    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: filePath, content: 'session-scoped-file' })
    });
    expect(writeResponse.status).toBe(200);

    const sessionResponse = await fetch(`${workerUrl}/api/session/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cwd: testDir })
    });
    expect(sessionResponse.status).toBe(200);
    const sessionData = (await sessionResponse.json()) as SessionCreateResult;

    const scopedListResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '.',
        options: { sessionId: sessionData.sessionId }
      })
    });
    expect(scopedListResponse.status).toBe(200);
    const scopedList = (await scopedListResponse.json()) as ListFilesResult;
    expect(
      scopedList.files.some((file) => file.name === 'session-only.txt')
    ).toBe(true);

    const sessionlessListResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '.',
        options: { sessionId: SESSIONLESS_SESSION_ID }
      })
    });
    expect(sessionlessListResponse.status).toBe(200);
    const sessionlessList =
      (await sessionlessListResponse.json()) as ListFilesResult;
    expect(
      sessionlessList.files.some((file) => file.name === 'session-only.txt')
    ).toBe(false);
  }, 90000);
});
