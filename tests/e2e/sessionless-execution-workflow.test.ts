import type {
  ExecResult,
  ListFilesResult,
  SessionCreateResult
} from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import {
  collectProcessStdout,
  collectProcessStreamEvents,
  startProcessViaTestWorker,
  streamProcessViaTestWorker
} from './helpers/process-stream';

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

  test('should run implicit exec calls without shared shell state', async () => {
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
  }, 90000);

  test('should stream implicit processes without a persistent shell', async () => {
    const setup = await executeCommand(
      workerUrl,
      headers,
      `export SESSIONLESS_STREAM_MARKER=hidden && printf '%s' "$SESSIONLESS_STREAM_MARKER"`
    );
    expect(setup.success).toBe(true);
    expect(setup.stdout).toBe('hidden');

    const process = await startProcessViaTestWorker(
      workerUrl,
      headers,
      `printf '%s' "\${SESSIONLESS_STREAM_MARKER:-missing}"`
    );
    const streamResponse = await streamProcessViaTestWorker(
      workerUrl,
      headers,
      process.id
    );
    expect(streamResponse.status).toBe(200);

    const events = await collectProcessStreamEvents(streamResponse);
    const exit = events.find((event) => event.type === 'exit');
    const error = events.find((event) => event.type === 'error');

    expect(collectProcessStdout(events)).toBe('missing');
    expect(exit).toBeDefined();
    expect(error).toBeUndefined();
  }, 90000);

  test('should time out implicit commands', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'sleep 1',
        timeout: 50
      })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecResult;

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('Command timed out after 50ms');
  }, 90000);

  test('should allow explicit session IDs', async () => {
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

    const headerScopedListResponse = await fetch(
      `${workerUrl}/api/list-files`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'X-Session-Id': sessionData.sessionId
        },
        body: JSON.stringify({
          path: '.'
        })
      }
    );
    expect(headerScopedListResponse.status).toBe(200);
    const headerScopedList =
      (await headerScopedListResponse.json()) as ListFilesResult;
    expect(
      headerScopedList.files.some((file) => file.name === 'session-only.txt')
    ).toBe(true);

    const headerSessionHeaders = {
      ...headers,
      'X-Session-Id': sessionData.sessionId
    };
    const headerSetMarker = await executeCommand(
      workerUrl,
      headerSessionHeaders,
      'export HEADER_SESSION_MARKER=present && printf "$HEADER_SESSION_MARKER"'
    );
    expect(headerSetMarker.success).toBe(true);
    expect(headerSetMarker.stdout).toBe('present');

    const headerReadMarker = await executeCommand(
      workerUrl,
      headerSessionHeaders,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template
      'printf "${HEADER_SESSION_MARKER:-missing}"'
    );
    expect(headerReadMarker.success).toBe(true);
    expect(headerReadMarker.stdout).toBe('present');

    const implicitReadMarker = await executeCommand(
      workerUrl,
      headers,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template
      'printf "${HEADER_SESSION_MARKER:-missing}"'
    );
    expect(implicitReadMarker.success).toBe(true);
    expect(implicitReadMarker.stdout).toBe('missing');

    const implicitListResponse = await fetch(`${workerUrl}/api/list-files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: testDir
      })
    });
    expect(implicitListResponse.status).toBe(200);
    const implicitList = (await implicitListResponse.json()) as ListFilesResult;
    expect(
      implicitList.files.some((file) => file.name === 'session-only.txt')
    ).toBe(true);
  }, 90000);
});
