import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { Process } from '@repo/shared';

// Dedicated port for this test file's port exposure error tests
const PORT_LIFECYCLE_TEST_PORT = 9998;

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
    });

    afterAll(async () => {
      // Only stop runner if we spawned one locally (CI uses deployed worker)
      if (runner) {
        await runner.stop();
      }
    });

    test('should start a server process and verify it runs', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Step 1: Start a simple sleep process (easier to test than a server)
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'sleep 30'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      expect(startData.id).toBeTruthy();
      const processId = startData.id;

      // Wait a bit for the process to start
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Step 2: Get process status
      const statusResponse = await fetch(
        `${workerUrl}/api/process/${processId}`,
        {
          method: 'GET',
          headers
        }
      );

      expect(statusResponse.status).toBe(200);
      const statusData = (await statusResponse.json()) as Process;
      expect(statusData.id).toBe(processId);
      expect(statusData.status).toBe('running');

      // Step 3: Cleanup - kill the process
      const killResponse = await fetch(
        `${workerUrl}/api/process/${processId}`,
        {
          method: 'DELETE',
          headers
        }
      );

      expect(killResponse.status).toBe(200);
    }, 90000);

    test('should list all running processes', async () => {
      const sandboxId = createSandboxId();
      const headers = createTestHeaders(sandboxId);

      // Start 2 long-running processes
      const process1Response = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'sleep 60'
        })
      });

      const process1Data = (await process1Response.json()) as Process;
      const process1Id = process1Data.id;

      const process2Response = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'sleep 60'
        })
      });

      const process2Data = (await process2Response.json()) as Process;
      const process2Id = process2Data.id;

      // Wait a bit for processes to be registered
      await new Promise((resolve) => setTimeout(resolve, 500));

      // List all processes
      const listResponse = await fetch(`${workerUrl}/api/process/list`, {
        method: 'GET',
        headers
      });

      expect(listResponse.status).toBe(200);
      const listData = (await listResponse.json()) as Process[];

      // Debug logging
      console.log('[DEBUG] List response:', JSON.stringify(listData, null, 2));
      console.log('[DEBUG] Process IDs started:', process1Id, process2Id);
      console.log('[DEBUG] SandboxId:', sandboxId);

      expect(Array.isArray(listData)).toBe(true);
      expect(listData.length).toBeGreaterThanOrEqual(2);

      // Verify our processes are in the list
      const processIds = listData.map((p) => p.id);
      expect(processIds).toContain(process1Id);
      expect(processIds).toContain(process2Id);

      // Cleanup - kill both processes
      await fetch(`${workerUrl}/api/process/${process1Id}`, {
        method: 'DELETE',
        headers
      });
      await fetch(`${workerUrl}/api/process/${process2Id}`, {
        method: 'DELETE',
        headers
      });
    }, 90000);

    test('should not block foreground operations when background processes are running', async () => {
      const sandboxId = createSandboxId();
      const headers = createTestHeaders(sandboxId);

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
      expect(execDuration).toBeLessThan(2000); // Should complete in <2s, not wait for sleep

      // Test listFiles as well - it uses the same foreground execution path
      const listStart = Date.now();
      const listResponse = await fetch(`${workerUrl}/api/list-files`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace'
        })
      });
      const listDuration = Date.now() - listStart;

      expect(listResponse.status).toBe(200);
      expect(listDuration).toBeLessThan(2000); // Should complete quickly

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 90000);

    test('should capture PID and logs immediately for fast commands', async () => {
      const sandboxId = createSandboxId();
      const headers = createTestHeaders(sandboxId);

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
      const sandboxId = createSandboxId();
      const headers = createTestHeaders(sandboxId);

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
        let timeout = Date.now() + 10000; // 10s timeout

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

      // Verify we received stream events
      expect(events.length).toBeGreaterThan(0);

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 90000);

    test.skipIf(skipPortExposureTests)(
      'should expose port and verify HTTP access',
      async () => {
        const sandboxId = createSandboxId();
        const headers = createTestHeaders(sandboxId);

        // Write and start a server
        const serverCode = `
const server = Bun.serve({
  port: 8080,
  fetch(req) {
    return new Response(JSON.stringify({ message: "Hello from Bun!" }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log("Server started on port 8080");
      `.trim();

        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/app.js',
            content: serverCode
          })
        });

        // Start the server
        const startResponse = await fetch(`${workerUrl}/api/process/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'bun run /workspace/app.js'
          })
        });

        const startData = (await startResponse.json()) as Process;
        const processId = startData.id;

        // Wait for server to start
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Expose port
        const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            port: 8080,
            name: 'test-server'
          })
        });

        expect(exposeResponse.status).toBe(200);
        const exposeData = (await exposeResponse.json()) as PortExposeResult;
        expect(exposeData.url).toBeTruthy();
        const previewUrl = exposeData.url!;

        // Make HTTP request to preview URL
        const healthResponse = await fetch(previewUrl);
        expect(healthResponse.status).toBe(200);
        const healthData = (await healthResponse.json()) as { message: string };
        expect(healthData.message).toBe('Hello from Bun!');

        // Cleanup - unexpose port and kill process
        await fetch(`${workerUrl}/api/exposed-ports/8080`, {
          method: 'DELETE'
        });

        await fetch(`${workerUrl}/api/process/${processId}`, {
          method: 'DELETE',
          headers
        });
      },
      90000
    );

    expect(killResponse.status).toBe(500);
    const errorData = (await killResponse.json()) as { error: string };
    expect(errorData.error).toBeTruthy();
    expect(errorData.error).toMatch(
      /not found|does not exist|invalid|unknown/i
    );
  }, 90000);

  test('should reject exposing reserved ports', async () => {
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
  }, 90000);

  test('should return error when unexposing non-exposed port', async () => {
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
  }, 90000);

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
});
