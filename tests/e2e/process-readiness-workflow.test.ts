import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import {
  createSandboxId,
  createTestHeaders,
  cleanupSandbox
} from './helpers/test-fixtures';
import type { Process, WaitForResult, PortExposeResult } from '@repo/shared';

// Port exposure tests require custom domain with wildcard DNS routing
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

/**
 * Process Readiness Workflow Integration Tests
 *
 * Tests the process readiness feature including:
 * - waitFor() method with string patterns
 * - waitFor() method with port checking
 * - startProcess() with ready option
 * - serve() method for server processes
 */
describe('Process Readiness Workflow', () => {
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
      if (currentSandboxId) {
        await cleanupSandbox(workerUrl, currentSandboxId);
        currentSandboxId = null;
      }
    });

    afterAll(async () => {
      if (runner) {
        await runner.stop();
      }
    });

    test('should wait for string pattern in process output', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Write a script that outputs a specific message after a delay
      const scriptCode = `
console.log("Starting up...");
await Bun.sleep(500);
console.log("Server ready on port 8080");
await Bun.sleep(60000); // Keep running
      `.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/server.js',
          content: scriptCode
        })
      });

      // Start the process
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/server.js'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      const processId = startData.id;

      // Wait for the pattern
      const waitResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitFor`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            condition: 'Server ready on port 8080',
            timeout: 10000
          })
        }
      );

      expect(waitResponse.status).toBe(200);
      const waitData = (await waitResponse.json()) as WaitForResult;
      expect(waitData.line).toContain('Server ready on port 8080');

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);

    test('should wait for port to become available', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Write a Bun server that listens on a port
      const serverCode = `
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 9090,
  fetch(req) {
    return new Response("OK");
  },
});
console.log("Server started on " + server.hostname + ":" + server.port);
// Keep process alive
await Bun.sleep(60000);
      `.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/portserver.js',
          content: serverCode
        })
      });

      // Start the process
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/portserver.js'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      const processId = startData.id;

      // Wait for port 9090 to be available
      const waitResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitFor`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            condition: 9090,
            timeout: 15000
          })
        }
      );

      expect(waitResponse.status).toBe(200);

      // Verify the port is actually listening by trying to curl it
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'curl -s http://localhost:9090'
        })
      });

      const verifyData = (await verifyResponse.json()) as { stdout: string };
      expect(verifyData.stdout).toBe('OK');

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);

    test('should start process with ready option and block until ready', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Write a script with delayed ready message
      const scriptCode = `
console.log("Initializing...");
await Bun.sleep(1000);
console.log("Database connected");
await Bun.sleep(500);
console.log("Ready to serve requests");
await Bun.sleep(60000);
      `.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/app.js',
          content: scriptCode
        })
      });

      // Start process with ready option - should block until pattern appears
      const startTime = Date.now();
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/app.js',
          ready: 'Ready to serve requests',
          readyTimeout: 10000
        })
      });
      const duration = Date.now() - startTime;

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;

      // Should have waited at least 1.5 seconds for the delayed output
      expect(duration).toBeGreaterThan(1000);

      // Process should be running
      expect(startData.status).toBe('running');

      // Cleanup
      await fetch(`${workerUrl}/api/process/${startData.id}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);

    test('should fail with timeout error if pattern never appears', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Write a script that never outputs the expected pattern
      const scriptCode = `
console.log("Starting...");
console.log("Still starting...");
await Bun.sleep(60000);
      `.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/slow.js',
          content: scriptCode
        })
      });

      // Start process with short timeout
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/slow.js',
          ready: 'Server ready',
          readyTimeout: 2000
        })
      });

      // Should fail with timeout
      expect(startResponse.status).toBe(500);
      const errorData = (await startResponse.json()) as { error: string };
      expect(errorData.error).toMatch(/timeout|did not become ready/i);
    }, 60000);

    test('should fail with error if process exits before becoming ready', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Start a process that exits immediately
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "quick exit"',
          ready: 'Server ready',
          readyTimeout: 10000
        })
      });

      // Should fail because process exits before pattern appears
      expect(startResponse.status).toBe(500);
      const errorData = (await startResponse.json()) as { error: string };
      expect(errorData.error).toMatch(
        /exited|exit|timeout|did not become ready/i
      );
    }, 60000);

    test.skipIf(skipPortExposureTests)(
      'should serve a process and expose port automatically',
      async () => {
        currentSandboxId = createSandboxId();
        const headers = createTestHeaders(currentSandboxId);

        // Write a simple HTTP server
        const serverCode = `
const server = Bun.serve({
  port: 8080,
  fetch(req) {
    return new Response(JSON.stringify({ message: "Hello!" }), {
      headers: { "Content-Type": "application/json" }
    });
  },
});
console.log("Server listening on port 8080");
        `.trim();

        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/http-server.js',
            content: serverCode
          })
        });

        // Use serve() to start, wait, and expose
        const serveResponse = await fetch(`${workerUrl}/api/serve`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'bun run /workspace/http-server.js',
            port: 8080,
            timeout: 30000
          })
        });

        expect(serveResponse.status).toBe(200);
        const serveData = (await serveResponse.json()) as {
          url: string;
          process: Process;
        };

        expect(serveData.url).toBeTruthy();
        expect(serveData.process.id).toBeTruthy();
        expect(serveData.process.status).toBe('running');

        // Make a request to the exposed URL
        const apiResponse = await fetch(serveData.url);
        expect(apiResponse.status).toBe(200);
        const apiData = (await apiResponse.json()) as { message: string };
        expect(apiData.message).toBe('Hello!');

        // Cleanup
        await fetch(`${workerUrl}/api/exposed-ports/8080`, {
          method: 'DELETE'
        });
        await fetch(`${workerUrl}/api/process/${serveData.process.id}`, {
          method: 'DELETE',
          headers
        });
      },
      90000
    );

    test.skipIf(skipPortExposureTests)(
      'should serve with custom ready pattern',
      async () => {
        currentSandboxId = createSandboxId();
        const headers = createTestHeaders(currentSandboxId);

        // Write a server with a custom ready message
        const serverCode = `
console.log("Connecting to database...");
await Bun.sleep(500);
console.log("Database connected successfully!");
const server = Bun.serve({
  port: 8080,
  fetch(req) {
    return new Response("OK");
  },
});
console.log("Server running");
        `.trim();

        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/custom-ready.js',
            content: serverCode
          })
        });

        // Use serve() with custom ready pattern
        const serveResponse = await fetch(`${workerUrl}/api/serve`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'bun run /workspace/custom-ready.js',
            port: 8080,
            ready: 'Database connected successfully!',
            timeout: 30000
          })
        });

        expect(serveResponse.status).toBe(200);
        const serveData = (await serveResponse.json()) as {
          url: string;
          process: Process;
        };

        expect(serveData.url).toBeTruthy();

        // Cleanup
        await fetch(`${workerUrl}/api/exposed-ports/8080`, {
          method: 'DELETE'
        });
        await fetch(`${workerUrl}/api/process/${serveData.process.id}`, {
          method: 'DELETE',
          headers
        });
      },
      90000
    );

    test('should detect pattern in stderr as well as stdout', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Write a script that outputs to stderr
      const scriptCode = `
console.error("Starting up in stderr...");
await Bun.sleep(300);
console.error("Ready (stderr)");
await Bun.sleep(60000);
      `.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/stderr.js',
          content: scriptCode
        })
      });

      // Start the process
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/stderr.js'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      const processId = startData.id;

      // Wait for the pattern (which appears in stderr)
      const waitResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitFor`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            condition: 'Ready (stderr)',
            timeout: 10000
          })
        }
      );

      expect(waitResponse.status).toBe(200);
      const waitData = (await waitResponse.json()) as WaitForResult;
      expect(waitData.line).toContain('Ready (stderr)');

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);
  });
});
