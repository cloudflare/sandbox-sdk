import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { Process, WaitForLogResult, PortExposeResult } from '@repo/shared';

// Port exposure tests require custom domain with wildcard DNS routing
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

/**
 * Process Readiness Workflow Integration Tests
 *
 * Tests the process readiness feature including:
 * - waitForLog() method with string and regex patterns
 * - waitForPort() method for port checking
 */

// Transport modes to test
const transportModes = [
  { name: 'HTTP', useWebSocket: false },
  { name: 'WebSocket', useWebSocket: true }
];

describe.each(transportModes)(
  'Process Readiness Workflow ($name transport)',
  ({ useWebSocket }) => {
    let workerUrl: string;
    let headers: Record<string, string>;
    let portHeaders: Record<string, string>;

    beforeAll(async () => {
      const sandbox = await getSharedSandbox();
      workerUrl = sandbox.workerUrl;
      const baseHeaders = sandbox.createHeaders(createUniqueSession());
      headers = useWebSocket
        ? { ...baseHeaders, 'X-Use-WebSocket': 'true' }
        : baseHeaders;
      // Port exposure requires sandbox headers (not session headers)
      portHeaders = useWebSocket
        ? {
            'X-Sandbox-Id': sandbox.sandboxId,
            'Content-Type': 'application/json',
            'X-Use-WebSocket': 'true'
          }
        : {
            'X-Sandbox-Id': sandbox.sandboxId,
            'Content-Type': 'application/json'
          };
    }, 120000);

    test('should wait for string pattern in process output', async () => {
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

      // Wait for the log pattern
      const waitResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitForLog`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            pattern: 'Server ready on port 8080',
            timeout: 10000
          })
        }
      );

      expect(waitResponse.status).toBe(200);
      const waitData = (await waitResponse.json()) as WaitForLogResult;
      expect(waitData.line).toContain('Server ready on port 8080');

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);

    test('should wait for port to become available', async () => {
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
        `${workerUrl}/api/process/${processId}/waitForPort`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            port: 9090,
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

    test('should chain waitForLog and waitForPort for multiple conditions', async () => {
      // Write a script with delayed ready message and a server
      const scriptCode = `
console.log("Initializing...");
await Bun.sleep(500);
console.log("Database connected");
await Bun.sleep(500);
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 9091,
  fetch(req) { return new Response("Ready"); },
});
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

      // Start the process
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/app.js'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      const processId = startData.id;

      // Wait for log pattern first
      const waitLogResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitForLog`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            pattern: 'Database connected',
            timeout: 10000
          })
        }
      );
      expect(waitLogResponse.status).toBe(200);

      // Then wait for port
      const waitPortResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitForPort`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            port: 9091,
            timeout: 10000
          })
        }
      );
      expect(waitPortResponse.status).toBe(200);

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);

    test('should fail with timeout error if pattern never appears', async () => {
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

      // Start the process
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'bun run /workspace/slow.js'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      const processId = startData.id;

      // Wait for pattern with short timeout - should fail
      const waitResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitForLog`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            pattern: 'Server ready',
            timeout: 2000
          })
        }
      );

      // Should fail with timeout
      expect(waitResponse.status).toBe(500);
      const errorData = (await waitResponse.json()) as { error: string };
      expect(errorData.error).toMatch(/timeout|did not become ready/i);

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);

    test('should fail with error if process exits before pattern appears', async () => {
      // Start a process that exits immediately
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "quick exit"'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      const processId = startData.id;

      // Wait for pattern - should fail because process exits
      const waitResponse = await fetch(
        `${workerUrl}/api/process/${processId}/waitForLog`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            pattern: 'Server ready',
            timeout: 10000
          })
        }
      );

      // Should fail because process exits before pattern appears
      expect(waitResponse.status).toBe(500);
      const errorData = (await waitResponse.json()) as { error: string };
      expect(errorData.error).toMatch(
        /exited|exit|timeout|did not become ready/i
      );
    }, 60000);

    test('should detect pattern in stderr as well as stdout', async () => {
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
        `${workerUrl}/api/process/${processId}/waitForLog`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            pattern: 'Ready (stderr)',
            timeout: 10000
          })
        }
      );

      expect(waitResponse.status).toBe(200);
      const waitData = (await waitResponse.json()) as WaitForLogResult;
      expect(waitData.line).toContain('Ready (stderr)');

      // Cleanup
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers
      });
    }, 60000);

    test.skipIf(skipPortExposureTests)(
      'should start server, wait for port, and expose it',
      async () => {
        // Write a simple HTTP server
        const serverCode = `
const server = Bun.serve({
  port: 9092,
  fetch(req) {
    return new Response(JSON.stringify({ message: "Hello!" }), {
      headers: { "Content-Type": "application/json" }
    });
  },
});
console.log("Server listening on port 9092");
      `.trim();

        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/http-server.js',
            content: serverCode
          })
        });

        // Start the process
        const startResponse = await fetch(`${workerUrl}/api/process/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'bun run /workspace/http-server.js'
          })
        });

        expect(startResponse.status).toBe(200);
        const startData = (await startResponse.json()) as Process;
        const processId = startData.id;

        // Wait for port
        const waitPortResponse = await fetch(
          `${workerUrl}/api/process/${processId}/waitForPort`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              port: 9092,
              timeout: 30000
            })
          }
        );
        expect(waitPortResponse.status).toBe(200);

        // Expose the port
        const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
          method: 'POST',
          headers: portHeaders,
          body: JSON.stringify({
            port: 9092
          })
        });

        expect(exposeResponse.status).toBe(200);
        const exposeData = (await exposeResponse.json()) as PortExposeResult;
        expect(exposeData.url).toBeTruthy();

        // Make a request to the exposed URL
        const apiResponse = await fetch(exposeData.url);
        expect(apiResponse.status).toBe(200);
        const apiData = (await apiResponse.json()) as { message: string };
        expect(apiData.message).toBe('Hello!');

        // Cleanup
        await fetch(`${workerUrl}/api/exposed-ports/9092`, {
          method: 'DELETE',
          headers: portHeaders
        });
        await fetch(`${workerUrl}/api/process/${processId}`, {
          method: 'DELETE',
          headers
        });
      },
      90000
    );
  }
);
