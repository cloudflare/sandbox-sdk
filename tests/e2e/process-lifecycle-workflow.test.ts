import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi
} from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import {
  createSandboxId,
  createTestHeaders,
  fetchWithStartup,
  cleanupSandbox
} from './helpers/test-fixtures';

// Port exposure tests require custom domain with wildcard DNS routing
// Skip these tests when running against workers.dev deployment (no wildcard support)
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

/**
 * Process Lifecycle Workflow Integration Tests
 *
 * Tests the README "Run a Node.js App" example (lines 443-471):
 * - Start a long-running server process
 * - Monitor process logs in real-time
 * - Get process status and details
 * - Expose port and verify HTTP access
 * - Kill process gracefully
 *
 * This validates the complete process management workflow:
 * Start → Monitor → Status Check → Port Exposure → HTTP Request → Cleanup
 *
 * Uses a real Bun HTTP server to test:
 * - Background process execution
 * - Process state management
 * - Log streaming (SSE)
 * - Port exposure and HTTP proxying
 * - Graceful process termination
 */
describe('Process Lifecycle Workflow', () => {
  describe('local', () => {
    let runner: WranglerDevRunner | null = null;
    let workerUrl: string;
    let currentSandboxId: string | null = null;

    beforeAll(async () => {
      const result = await getTestWorkerUrl();
      workerUrl = result.url;
      runner = result.runner;
    });

    afterEach(async () => {
      // Cleanup sandbox container after each test
      if (currentSandboxId) {
        await cleanupSandbox(workerUrl, currentSandboxId);
        currentSandboxId = null;
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
      const startResponse = await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/process/start`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: 'sleep 30'
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      expect(startResponse.status).toBe(200);
      const startData = await startResponse.json();
      expect(startData.id).toBeTruthy();
      expect(startData.status).toBe('running');
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
      const statusData = await statusResponse.json();
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
      const process1Response = await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/process/start`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: 'sleep 60'
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      const process1Data = await process1Response.json();
      const process1Id = process1Data.id;

      const process2Response = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'sleep 60'
        })
      });

      const process2Data = await process2Response.json();
      const process2Id = process2Data.id;

      // Wait a bit for processes to be registered
      await new Promise((resolve) => setTimeout(resolve, 500));

      // List all processes
      const listResponse = await fetch(`${workerUrl}/api/process/list`, {
        method: 'GET',
        headers
      });

      expect(listResponse.status).toBe(200);
      const listData = await listResponse.json();

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
      const startResponse = await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/process/start`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: 'sleep 60'
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      const startData = await startResponse.json();
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

    test('should get process logs after execution', async () => {
      const sandboxId = createSandboxId();
      const headers = createTestHeaders(sandboxId);

      // Start a process that outputs to stdout
      const startResponse = await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/process/start`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: 'echo "Hello from process"'
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      const startData = await startResponse.json();
      const processId = startData.id;

      // Wait for process to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get process logs
      const logsResponse = await fetch(
        `${workerUrl}/api/process/${processId}/logs`,
        {
          method: 'GET',
          headers
        }
      );

      expect(logsResponse.status).toBe(200);
      const logsData = await logsResponse.json();
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

      await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/file/write`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              path: '/workspace/script.js',
              content: scriptCode
            })
          }),
        { timeout: 90000, interval: 2000 }
      );

      // Start the script
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/script.js'
        })
      });

      const startData = await startResponse.json();
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

        await vi.waitFor(
          async () =>
            fetchWithStartup(`${workerUrl}/api/file/write`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                path: '/workspace/app.js',
                content: serverCode
              })
            }),
          { timeout: 90000, interval: 2000 }
        );

        // Start the server
        const startResponse = await fetch(`${workerUrl}/api/process/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'bun run /workspace/app.js'
          })
        });

        const startData = await startResponse.json();
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
        const exposeData = await exposeResponse.json();
        expect(exposeData.url).toBeTruthy();
        const previewUrl = exposeData.url;

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

    test('should kill all processes at once', async () => {
      const sandboxId = createSandboxId();
      const headers = createTestHeaders(sandboxId);

      // Start 3 long-running processes
      const processes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const startResponse = await vi.waitFor(
          async () =>
            fetchWithStartup(`${workerUrl}/api/process/start`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                command: 'sleep 120'
              })
            }),
          { timeout: 90000, interval: 2000 }
        );

        const data = await startResponse.json();
        processes.push(data.id);
      }

      // Wait for all processes to be registered
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify all processes are running
      const listResponse = await fetch(`${workerUrl}/api/process/list`, {
        method: 'GET',
        headers
      });
      const listData = await listResponse.json();
      expect(listData.length).toBeGreaterThanOrEqual(3);

      // Kill all processes
      const killAllResponse = await fetch(`${workerUrl}/api/process/kill-all`, {
        method: 'POST',
        headers,
        body: JSON.stringify({})
      });

      expect(killAllResponse.status).toBe(200);

      // Verify processes are killed (list should be empty or only have non-running processes)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const listAfterResponse = await fetch(`${workerUrl}/api/process/list`, {
        method: 'GET',
        headers
      });
      const listAfterData = await listAfterResponse.json();

      // Should have fewer running processes now
      const runningProcesses = listAfterData.filter(
        (p) => p.status === 'running'
      );
      expect(runningProcesses.length).toBe(0);
    }, 90000);

    test.skipIf(skipPortExposureTests)(
      'should handle complete workflow: write → start → monitor → expose → request → cleanup',
      async () => {
        const sandboxId = createSandboxId();
        const headers = createTestHeaders(sandboxId);

        // Complete realistic workflow
        const serverCode = `
const server = Bun.serve({
  port: 8080,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log("Server listening on port 8080");
      `.trim();

        // Step 1: Write server code
        await vi.waitFor(
          async () =>
            fetchWithStartup(`${workerUrl}/api/file/write`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                path: '/workspace/health-server.js',
                content: serverCode
              })
            }),
          { timeout: 90000, interval: 2000 }
        );

        // Step 2: Start the process
        const startResponse = await fetch(`${workerUrl}/api/process/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'bun run /workspace/health-server.js'
          })
        });

        expect(startResponse.status).toBe(200);
        const startData = await startResponse.json();
        const processId = startData.id;

        // Step 3: Wait and verify process is running
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const statusResponse = await fetch(
          `${workerUrl}/api/process/${processId}`,
          {
            method: 'GET',
            headers
          }
        );

        expect(statusResponse.status).toBe(200);
        const statusData = await statusResponse.json();
        expect(statusData.status).toBe('running');

        // Step 4: Expose port
        const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            port: 8080,
            name: 'health-api'
          })
        });

        expect(exposeResponse.status).toBe(200);
        const exposeData = await exposeResponse.json();
        const previewUrl = exposeData.url;

        // Step 5: Make HTTP request to health endpoint
        const healthResponse = await fetch(
          new URL('/health', previewUrl).toString()
        );
        expect(healthResponse.status).toBe(200);
        const healthData = (await healthResponse.json()) as { status: string };
        expect(healthData.status).toBe('ok');

        // Step 6: Get process logs
        const logsResponse = await fetch(
          `${workerUrl}/api/process/${processId}/logs`,
          {
            method: 'GET',
            headers
          }
        );

        expect(logsResponse.status).toBe(200);
        const logsData = await logsResponse.json();
        expect(logsData.stdout).toContain('Server listening on port 8080');

        // Step 7: Cleanup - unexpose port and kill the process
        await fetch(`${workerUrl}/api/exposed-ports/8080`, {
          method: 'DELETE'
        });

        const killResponse = await fetch(
          `${workerUrl}/api/process/${processId}`,
          {
            method: 'DELETE',
            headers
          }
        );

        expect(killResponse.status).toBe(200);
      },
      120000
    );

    test('should return error when killing nonexistent process', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Try to kill a process that doesn't exist
      const killResponse = await vi.waitFor(
        async () =>
          fetchWithStartup(
            `${workerUrl}/api/process/fake-process-id-12345`,
            {
              method: 'DELETE',
              headers
            },
            { expectSuccess: false }
          ),
        { timeout: 90000, interval: 2000 }
      );

      // Should return error
      expect(killResponse.status).toBe(500);
      const errorData = (await killResponse.json()) as { error: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(
        /not found|does not exist|invalid|unknown/i
      );
    }, 90000);

    test.skipIf(skipPortExposureTests)(
      'should reject exposing reserved ports',
      async () => {
        currentSandboxId = createSandboxId();
        const headers = createTestHeaders(currentSandboxId);

        // Try to expose a reserved port (e.g., port 22 - SSH)
        const exposeResponse = await vi.waitFor(
          async () =>
            fetchWithStartup(
              `${workerUrl}/api/port/expose`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  port: 22,
                  name: 'ssh-server'
                })
              },
              { expectSuccess: false }
            ),
          { timeout: 90000, interval: 2000 }
        );

        // Should return error for reserved port
        expect(exposeResponse.status).toBe(500);
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
        currentSandboxId = createSandboxId();
        const headers = createTestHeaders(currentSandboxId);

        // Initialize sandbox first
        await vi.waitFor(
          async () =>
            fetchWithStartup(`${workerUrl}/api/execute`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                command: 'echo "init"'
              })
            }),
          { timeout: 90000, interval: 2000 }
        );

        // Try to unexpose a port that was never exposed
        const unexposeResponse = await fetch(
          `${workerUrl}/api/exposed-ports/9999`,
          {
            method: 'DELETE'
          }
        );

        // Should return error
        expect(unexposeResponse.status).toBe(500);
        const errorData = (await unexposeResponse.json()) as { error: string };
        expect(errorData.error).toBeTruthy();
        expect(errorData.error).toMatch(
          /not found|not exposed|does not exist/i
        );
      },
      90000
    );
  });
});
