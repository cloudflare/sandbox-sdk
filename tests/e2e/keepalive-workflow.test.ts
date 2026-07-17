import type { ProcessStatus, ReadFileResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import { waitForContainerStopped } from './helpers/container-lifecycle';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import { sleep } from './helpers/test-fixtures';

/**
 * KeepAlive Feature Tests
 *
 * Tests the keepAlive header functionality using an isolated sandbox so
 * background activity and alarms from other files cannot affect assertions.
 *
 * What we verify:
 * 1. keepAlive header is accepted and enables the mode
 * 2. Multiple commands work with keepAlive enabled
 * 3. File and process operations work with keepAlive
 * 4. Explicit destroy works (cleanup endpoint)
 */
describe('KeepAlive Feature', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox({ sleepAfter: '3s' });
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);
  test('should accept keepAlive header and execute commands', async () => {
    const keepAliveHeaders = { ...headers, 'X-Sandbox-KeepAlive': 'true' };

    // First command with keepAlive
    const response1 = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "keepAlive command 1"']
      })
    });
    expect(response1.status).toBe(200);
    const data1 = (await response1.json()) as CommandResponse;
    expect(data1.stdout).toContain('keepAlive command 1');

    // Second command immediately after
    const response2 = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'echo "keepAlive command 2"']
      })
    });
    expect(response2.status).toBe(200);
    const data2 = (await response2.json()) as CommandResponse;
    expect(data2.stdout).toContain('keepAlive command 2');
  }, 30000);

  test('should support background processes with keepAlive', async () => {
    const keepAliveHeaders = { ...headers, 'X-Sandbox-KeepAlive': 'true' };

    const response = await fetch(`${workerUrl}/api/kill-running-exec`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({ command: ['/bin/bash', '-lc', 'sleep 30'] })
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { exitCode: number };
    expect(result.exitCode).not.toBe(0);
  }, 30000);

  test('sleepAfter 3s keeps active process and terminal alive, then idles', async () => {
    const processResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/bash', '-lc', 'sleep 8'] })
    });
    expect(processResponse.status).toBe(200);
    const processData = (await processResponse.json()) as { id: string };

    const terminalResponse = await fetch(`${workerUrl}/api/terminal/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/bash'], cols: 80, rows: 24 })
    });
    expect(terminalResponse.status).toBe(200);
    const terminalData = (await terminalResponse.json()) as { id: string };

    await sleep(4500);

    const processStatusResponse = await fetch(
      `${workerUrl}/api/process/${processData.id}`,
      { headers }
    );
    expect(processStatusResponse.status).toBe(200);
    const processStatus = (await processStatusResponse.json()) as ProcessStatus;
    expect(processStatus.state).toBe('running');

    const terminalSnapshotResponse = await fetch(
      `${workerUrl}/api/terminal/${terminalData.id}`,
      { headers }
    );
    expect(terminalSnapshotResponse.status).toBe(200);
    const terminalSnapshot = (await terminalSnapshotResponse.json()) as {
      status: string;
    };
    expect(terminalSnapshot.status).toBe('running');

    const terminalTerminateResponse = await fetch(
      `${workerUrl}/api/terminal/${terminalData.id}/terminate`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({})
      }
    );
    expect(terminalTerminateResponse.status).toBe(200);
    const processWaitResponse = await fetch(
      `${workerUrl}/api/process/${processData.id}/wait`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ timeout: 10000 })
      }
    );
    expect(processWaitResponse.status).toBe(200);
    const processExit = (await processWaitResponse.json()) as {
      code: number;
    };
    expect(processExit.code).toBe(0);

    await waitForContainerStopped(workerUrl, headers, { timeoutMs: 15000 });
  }, 30000);

  test('should work with file operations and keepAlive', async () => {
    const keepAliveHeaders = { ...headers, 'X-Sandbox-KeepAlive': 'true' };
    const testPath = `/workspace/keepalive-test-${Date.now()}.txt`;

    // Write file with keepAlive
    const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({
        path: testPath,
        content: 'keepAlive file content'
      })
    });
    expect(writeResponse.status).toBe(200);

    // Read file with keepAlive
    const readResponse = await fetch(`${workerUrl}/api/file/read`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({ path: testPath })
    });
    expect(readResponse.status).toBe(200);
    const readData = (await readResponse.json()) as ReadFileResult;
    expect(readData.content).toBe('keepAlive file content');

    // Cleanup
    await fetch(`${workerUrl}/api/file/delete`, {
      method: 'DELETE',
      headers: keepAliveHeaders,
      body: JSON.stringify({ path: testPath })
    });
  }, 30000);
});
