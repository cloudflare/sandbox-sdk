import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { stopContainerAndWait } from './helpers/container-lifecycle';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import {
  cleanupSandbox,
  createSandboxId,
  createTestHeaders
} from './helpers/test-fixtures';

type ProcessStatus = { id: string; state: string };
type ExecuteResponse = { success: boolean; stdout: string; exitCode: number };

describe('Runtime incarnation lifecycle workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox({ initCommand: ['true'] });
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  async function post(path: string, body: unknown = {}): Promise<Response> {
    return await fetch(`${workerUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000)
    });
  }

  async function get(path: string): Promise<Response> {
    return await fetch(`${workerUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(90000)
    });
  }

  test('admits concurrent cold process launches and recovers handles in later requests', async () => {
    const coldSandboxId = createSandboxId();
    const coldHeaders = createTestHeaders(coldSandboxId);
    const coldPost = async (path: string, body: unknown = {}) =>
      await fetch(`${workerUrl}${path}`, {
        method: 'POST',
        headers: coldHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000)
      });
    const coldGet = async (path: string) =>
      await fetch(`${workerUrl}${path}`, {
        headers: coldHeaders,
        signal: AbortSignal.timeout(90000)
      });

    try {
      const [first, second] = await Promise.all([
        coldPost('/api/process/start', {
          command: ['/bin/bash', '-lc', 'echo first-ready; sleep 20']
        }),
        coldPost('/api/process/start', {
          command: ['/bin/bash', '-lc', 'echo second-ready; sleep 20']
        })
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstStatus = (await first.json()) as ProcessStatus;
      const secondStatus = (await second.json()) as ProcessStatus;
      expect(firstStatus.id).not.toBe(secondStatus.id);

      const recovered = await coldGet(`/api/process/${firstStatus.id}`);
      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toMatchObject({
        id: firstStatus.id,
        state: expect.stringMatching(/running|exited/)
      });

      await coldPost(`/api/process/${firstStatus.id}/kill`, { signal: 15 });
      await coldPost(`/api/process/${secondStatus.id}/kill`, { signal: 15 });
    } finally {
      await cleanupSandbox(workerUrl, coldSandboxId);
    }
  }, 120000);

  test('does not revive stale process or terminal IDs after runtime stop', async () => {
    const processResponse = await post('/api/process/start', {
      command: ['/bin/bash', '-lc', 'echo stale-ready; sleep 30']
    });
    expect(processResponse.status).toBe(200);
    const process = (await processResponse.json()) as ProcessStatus;

    const terminalResponse = await post('/api/terminal/create', {
      command: ['bash']
    });
    expect(terminalResponse.status).toBe(200);
    const terminal = (await terminalResponse.json()) as { id: string };

    await stopContainerAndWait(workerUrl, headers);

    const processLookup = await get(`/api/process/${process.id}`);
    expect(processLookup.status).toBe(404);

    const terminalLookup = await get(`/api/terminal/${terminal.id}`);
    expect(terminalLookup.status).toBe(404);

    const replacement = await post('/api/execute', {
      command: ['printf', 'replacement-ready']
    });
    expect(replacement.status).toBe(200);
    await expect(replacement.json()).resolves.toMatchObject({
      success: true,
      stdout: 'replacement-ready'
    });
  }, 120000);

  test('interrupts retained runtime streams and recovers through a new session', async () => {
    const response = await post('/api/runtime/retained-log-interruption');
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      interrupted: boolean;
      errorName: string;
      recoveryStdout: string;
    };

    expect(result.interrupted).toBe(true);
    expect(result.errorName).toBe('RPCTransportError');
    expect(result.recoveryStdout).toBe('after-interruption');
  }, 120000);

  test('invalidates the runtime when the control server exits', async () => {
    const response = await post('/api/runtime/control-server-exit');
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      stateStatus: string;
      interruption: { originalMessage: string };
      recoveryStdout: string;
    };

    expect(['stopped', 'stopped_with_code']).toContain(result.stateStatus);
    expect(result).toMatchObject({
      interruption: {
        originalMessage: expect.stringContaining('StaleProcessHandleError')
      },
      recoveryStdout: 'after-control-server-exit'
    });
  }, 120000);

  test('coalesces concurrent destroy and leaves lookup paths non-waking', async () => {
    const activeProcess = await post('/api/process/start', {
      command: ['/bin/bash', '-lc', 'echo destroy-ready; sleep 30']
    });
    expect(activeProcess.status).toBe(200);

    const response = await post('/api/runtime/concurrent-destroy');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fulfilled: 2,
      rejected: 0,
      listAfterDestroy: []
    });

    const stateBeforeLookups = (await (await get('/api/state')).json()) as {
      status: string;
    };
    expect(stateBeforeLookups.status).not.toBe('healthy');

    const [listResponse, previewsResponse, exposedResponse] = await Promise.all(
      [
        get('/api/process/list'),
        get('/api/exposed-ports'),
        get('/api/exposed-ports/8080')
      ]
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([]);
    expect(previewsResponse.status).toBe(200);
    await expect(previewsResponse.json()).resolves.toEqual([]);
    expect(exposedResponse.status).toBe(200);
    await expect(exposedResponse.json()).resolves.toEqual({
      exposed: false,
      port: 8080
    });

    const stateAfterLookups = (await (await get('/api/state')).json()) as {
      status: string;
    };
    expect(stateAfterLookups.status).toBe(stateBeforeLookups.status);
  }, 120000);

  test('cold exec regression completes without startup recursion', async () => {
    await stopContainerAndWait(workerUrl, headers);
    const response = await post('/api/execute', {
      command: ['echo', 'ready']
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecuteResponse;
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('ready');
  }, 120000);
});
