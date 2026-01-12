import type { Process, ProcessLogsResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

// Dedicated port for this test file's port exposure error tests
const PORT_LIFECYCLE_TEST_PORT = 9998;
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

/**
 * Process Lifecycle Error Handling Tests
 *
 * Tests error cases for process management.
 * Happy path tests (start, list, logs, kill, kill-all) are in comprehensive-workflow.test.ts.
 *
 * This file focuses on:
 * - Killing nonexistent process
 * - Exposing reserved ports
 * - Unexposing non-exposed ports
 * - Foreground operations not blocking on background processes
 */
describe('Process Lifecycle Error Handling', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
    // Port exposure requires sandbox headers (not session headers)
    portHeaders = {
      'X-Sandbox-Id': sandbox.sandboxId,
      'Content-Type': 'application/json'
    };
  }, 120000);

  test('should return error when killing nonexistent process', async () => {
    const killResponse = await fetch(
      `${workerUrl}/api/process/fake-process-id-12345`,
      {
        method: 'DELETE',
        headers
      }
    );

    expect(killResponse.status).toBe(500);
    const errorData = (await killResponse.json()) as { error: string };
    expect(errorData.error).toBeTruthy();
    expect(errorData.error).toMatch(
      /not found|does not exist|invalid|unknown/i
    );
  }, 90000);

  test('should capture PID and logs immediately for fast commands', async () => {
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "Hello from process"'
      })
    });

    expect(startResponse.status).toBe(200);
    const startData = (await startResponse.json()) as Process;
    const processId = startData.id;

    // PID should be available immediately
    expect(startData.pid).toBeDefined();
    expect(typeof startData.pid).toBe('number');

    // Logs should be available immediately for fast commands
    const logsResponse = await fetch(
      `${workerUrl}/api/process/${processId}/logs`,
      {
        method: 'GET',
        headers
      }
    );

    expect(logsResponse.status).toBe(200);
    const logsData = (await logsResponse.json()) as ProcessLogsResult;
    expect(logsData.stdout).toContain('Hello from process');
  }, 90000);

  test('should stream process logs in real-time', async () => {
    // Write a script that outputs multiple lines
    const scriptCode = `
console.log("Line 1");
await Bun.sleep(100);
console.log("Line 2");
await Bun.sleep(100);
console.log("Line 3");
    `.trim();

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/script.js',
        content: scriptCode
      })
    });

    // Start the script
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'bun run /workspace/script.js'
      })
    });

    const startData = (await startResponse.json()) as Process;
    const processId = startData.id;

    // Stream logs (SSE)
    const streamResponse = await fetch(
      `${workerUrl}/api/process/${processId}/stream`,
      {
        method: 'GET',
        headers
      }
    );

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toBe(
      'text/event-stream'
    );

    // Collect events from the stream
    const reader = streamResponse.body?.getReader();
    const decoder = new TextDecoder();
    const events: any[] = [];

    if (reader) {
      let done = false;
      const timeout = Date.now() + 10000; // 10s timeout

      while (!done && Date.now() < timeout) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;

        if (value) {
          const chunk = decoder.decode(value);
          const lines = chunk
            .split('\n\n')
            .filter((line) => line.startsWith('data: '));

          for (const line of lines) {
            const eventData = line.replace('data: ', '');
            try {
              events.push(JSON.parse(eventData));
            } catch (e) {
              // Skip malformed events
            }
          }
        }

        // Stop after collecting some events
        if (events.length >= 3) {
          reader.cancel();
          break;
        }
      }
    }
  }, 90000);

  test.skipIf(skipPortExposureTests)(
    'should reject exposing reserved ports',
    async () => {
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: 22,
          name: 'ssh-server'
        })
      });

      expect(exposeResponse.status).toBeGreaterThanOrEqual(400);
      const errorData = (await exposeResponse.json()) as { error: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(
        /reserved|not allowed|forbidden|invalid port/i
      );
    },
    90000
  );

  test.skipIf(skipPortExposureTests)(
    'should return error when unexposing non-exposed port',
    async () => {
      const unexposeResponse = await fetch(
        `${workerUrl}/api/exposed-ports/${PORT_LIFECYCLE_TEST_PORT}`,
        {
          method: 'DELETE',
          headers: portHeaders
        }
      );

      expect(unexposeResponse.status).toBe(500);
      const errorData = (await unexposeResponse.json()) as { error: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(/not found|not exposed|does not exist/i);
    },
    90000
  );

  test('should not block foreground operations when background processes are running', async () => {
    // Start a long-running background process
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'sleep 60'
      })
    });

    const startData = (await startResponse.json()) as Process;
    const processId = startData.id;

    // Immediately run a foreground command - should complete quickly
    const execStart = Date.now();
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "test"'
      })
    });
    const execDuration = Date.now() - execStart;

    expect(execResponse.status).toBe(200);
    expect(execDuration).toBeLessThan(2000); // Should complete in <2s

    // Cleanup
    await fetch(`${workerUrl}/api/process/${processId}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should kill process and verify idempotent deletion', async () => {
    // Start a simple long-running process
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `sleep 300`
      })
    });

    expect(startResponse.status).toBe(200);
    const startData = (await startResponse.json()) as Process;
    const processId = startData.id;

    // Wait for process to be fully started
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Kill the process
    const killResponse = await fetch(`${workerUrl}/api/process/${processId}`, {
      method: 'DELETE',
      headers
    });
    expect(killResponse.status).toBe(200);

    // Wait for the process to exit
    const waitExitResponse = await fetch(
      `${workerUrl}/api/process/${processId}/waitForExit`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ timeout: 5000 })
      }
    );
    expect(waitExitResponse.status).toBe(200);

    // Verify idempotency: killing an already-killed process should not crash
    const secondKillResponse = await fetch(
      `${workerUrl}/api/process/${processId}`,
      {
        method: 'DELETE',
        headers
      }
    );
    // Should either succeed (200) or return a "not found" error (4xx/5xx)
    // The key is it should NOT crash the server
    expect([200, 404, 500]).toContain(secondKillResponse.status);
  }, 90000);
});
