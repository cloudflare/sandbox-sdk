import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, fetchWithStartup, cleanupSandbox } from './helpers/test-fixtures';

// Port exposure tests require custom domain with wildcard DNS routing
// Skip these tests when running against workers.dev deployment (no wildcard support)
const skipWebSocketTests = process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

/**
 * WebSocket Workflow Integration Tests
 *
 * Tests WebSocket support for exposed sandbox ports.
 *
 * SCOPE: Phase 1 - WebSocket Routing Validation
 * This test validates that WebSocket upgrade requests are correctly routed
 * through the sandbox infrastructure (Worker → proxyToSandbox → Sandbox.fetch → Container).
 *
 * NOT TESTED HERE:
 * - Long-running connection timeout management (Phase 2)
 * - Keep-alive strategies (Phase 2)
 * - Error recovery and reconnection (Phase 3)
 * - Concurrent connections or load testing (Phase 4)
 *
 * KNOWN LIMITATION:
 * Current runtime has 30-second CPU timeout without keep-alive mechanism.
 * This test keeps connections brief (< 5s) to validate routing correctness only.
 * Timeout management will be addressed in Phase 2.
 */
describe('WebSocket Workflow', () => {
  describe.skipIf(skipWebSocketTests)('local', () => {
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
      if (runner) {
        await runner.stop();
      }
    });

    test('should connect to WebSocket server via exposed port and echo messages', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Read the WebSocket echo server fixture
      const serverCode = readFileSync(
        join(__dirname, 'fixtures', 'websocket-echo-server.ts'),
        'utf-8'
      );

      // Step 1: Write the WebSocket echo server to the container
      await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            path: '/workspace/ws-server.ts',
            content: serverCode,
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      // Step 2: Start the WebSocket server as a background process
      const port = 8080;
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `bun run /workspace/ws-server.ts ${port}`,
        }),
      });

      expect(startResponse.status).toBe(200);
      const processData = await startResponse.json();
      const processId = processData.id;
      expect(processData.status).toBe('running');

      // Wait for server to be ready (generous timeout for first startup)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 3: Expose the port to get preview URL
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          port,
          name: 'websocket-test',
        }),
      });

      expect(exposeResponse.status).toBe(200);
      const exposeData = await exposeResponse.json();
      expect(exposeData.url).toBeTruthy();
      console.log('[DEBUG] Preview URL:', exposeData.url);

      // Step 4: Connect to WebSocket via preview URL
      // Convert http:// to ws:// for WebSocket protocol
      const wsUrl = exposeData.url.replace(/^http/, 'ws');

      const ws = new WebSocket(wsUrl);

      // Wait for connection to open
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (error) => reject(error));
        setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000);
      });

      console.log('[DEBUG] WebSocket connected');

      // Step 5: Send a message and verify echo
      const testMessage = 'Hello WebSocket!';
      const messagePromise = new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => {
          resolve(data.toString());
        });
        setTimeout(() => reject(new Error('Echo timeout')), 5000);
      });

      ws.send(testMessage);
      const echoedMessage = await messagePromise;

      expect(echoedMessage).toBe(testMessage);
      console.log('[DEBUG] Message echoed successfully:', echoedMessage);

      // Step 6: Close WebSocket connection gracefully
      ws.close();
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        setTimeout(() => resolve(), 1000); // Fallback timeout
      });

      // Step 7: Cleanup - kill process and unexpose port
      await fetch(`${workerUrl}/api/process/${processId}`, {
        method: 'DELETE',
        headers,
      });

      await fetch(`${workerUrl}/api/exposed-ports/${port}`, {
        method: 'DELETE',
        headers,
      });
    }, 90000);
  });
});
