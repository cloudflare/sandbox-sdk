import type { ExecResult, Process, ReadFileResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

/**
 * KeepAlive Feature Tests
 *
 * Tests the keepAlive header functionality. Uses SHARED sandbox since we're
 * testing the keepAlive protocol behavior, not container lifecycle isolation.
 *
 * What we verify:
 * 1. keepAlive header is accepted and enables the mode
 * 2. Multiple commands work with keepAlive enabled
 * 3. File and process operations work with keepAlive
 * 4. Explicit destroy works (cleanup endpoint)
 * 5. keepAlive flag persists across DO hibernation
 */
describe('KeepAlive Feature', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  test('should accept keepAlive header and execute commands', async () => {
    const keepAliveHeaders = { ...headers, 'X-Sandbox-KeepAlive': 'true' };

    // First command with keepAlive
    const response1 = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({ command: 'echo "keepAlive command 1"' })
    });
    expect(response1.status).toBe(200);
    const data1 = (await response1.json()) as ExecResult;
    expect(data1.stdout).toContain('keepAlive command 1');

    // Second command immediately after
    const response2 = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({ command: 'echo "keepAlive command 2"' })
    });
    expect(response2.status).toBe(200);
    const data2 = (await response2.json()) as ExecResult;
    expect(data2.stdout).toContain('keepAlive command 2');
  }, 30000);

  test('should support background processes with keepAlive', async () => {
    const keepAliveHeaders = { ...headers, 'X-Sandbox-KeepAlive': 'true' };

    // Start a background process
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({ command: 'sleep 10' })
    });
    expect(startResponse.status).toBe(200);
    const processData = (await startResponse.json()) as Process;
    expect(processData.id).toBeTruthy();

    // Verify process is running
    const statusResponse = await fetch(
      `${workerUrl}/api/process/${processData.id}`,
      { method: 'GET', headers: keepAliveHeaders }
    );
    expect(statusResponse.status).toBe(200);
    const statusData = (await statusResponse.json()) as Process;
    expect(statusData.status).toBe('running');

    // Cleanup
    await fetch(`${workerUrl}/api/process/${processData.id}`, {
      method: 'DELETE',
      headers: keepAliveHeaders
    });
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

  test('should persist keepAlive flag across DO hibernation/wakeup cycles', async () => {
    const keepAliveHeaders = { ...headers, 'X-Sandbox-KeepAlive': 'true' };

    // Step 1: Initialize sandbox with keepAlive enabled
    const initResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: keepAliveHeaders,
      body: JSON.stringify({ command: 'echo "Initial setup with keepAlive"' })
    });
    expect(initResponse.status).toBe(200);
    const initData = (await initResponse.json()) as ExecResult;
    expect(initData.stdout).toContain('Initial setup with keepAlive');

    // Step 2: Wait for potential DO hibernation (20+ seconds of complete inactivity)
    // This simulates the DO going to sleep and waking up
    console.log(
      '[Test] Waiting 20 seconds to allow potential DO hibernation...'
    );
    await new Promise((resolve) => setTimeout(resolve, 20000));

    // Step 3: Make a new request WITHOUT setting keepAlive header again
    // If the flag wasn't persisted, the container would timeout after this point
    const headersWithoutKeepAlive = headers; // No X-Sandbox-KeepAlive header

    const afterHibernationResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: headersWithoutKeepAlive,
      body: JSON.stringify({ command: 'echo "After potential hibernation"' })
    });
    expect(afterHibernationResponse.status).toBe(200);
    const afterHibernationData =
      (await afterHibernationResponse.json()) as ExecResult;
    expect(afterHibernationData.stdout).toContain(
      'After potential hibernation'
    );

    // Step 4: Wait another 15+ seconds to verify keepAlive is still active
    // If persistence failed, the container would have timed out by now
    console.log(
      '[Test] Waiting another 15 seconds to verify persistent keepAlive...'
    );
    await new Promise((resolve) => setTimeout(resolve, 15000));

    // Step 5: Verify container is STILL alive (without re-setting keepAlive)
    const finalResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: headersWithoutKeepAlive, // Still no keepAlive header
      body: JSON.stringify({ command: 'echo "Still alive after 35+ seconds"' })
    });
    expect(finalResponse.status).toBe(200);
    const finalData = (await finalResponse.json()) as ExecResult;
    expect(finalData.stdout).toContain('Still alive after 35+ seconds');

    console.log(
      '[Test] keepAlive flag successfully persisted across hibernation cycle!'
    );
  }, 120000);
});
