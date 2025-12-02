import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { getSharedSandbox } from './helpers/global-sandbox';
import type { Process, PortExposeResult } from '@repo/shared';

// Skip - port exposure requires exclusive port access which conflicts with parallel test execution
// This test can be run standalone if needed: npm run test:e2e:shared -- websocket-workflow
const skipWebSocketTests = true;

/**
 * WebSocket Port Exposure Tests
 *
 * Tests WebSocket via exposed ports. Uses SHARED sandbox with unique session.
 */
describe('WebSocket Port Exposure', () => {
  describe.skipIf(skipWebSocketTests)('local', () => {
    let workerUrl: string;
    let headers: Record<string, string>;
    let sandboxId: string;

    beforeAll(async () => {
      const sandbox = await getSharedSandbox();
      workerUrl = sandbox.workerUrl;
      sandboxId = sandbox.sandboxId;
      // Port exposure requires sandbox headers, not session headers
      headers = {
        'X-Sandbox-Id': sandboxId,
        'Content-Type': 'application/json'
      };
    }, 120000);

    test('should connect to WebSocket server via exposed port', async () => {
      // Write the echo server
      const serverCode = readFileSync(
        join(__dirname, 'fixtures', 'websocket-echo-server.ts'),
        'utf-8'
      );
      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/ws-server.ts',
          content: serverCode
        })
      });

      // Start server
      const port = 8080 + Math.floor(Math.random() * 1000); // Random port to avoid conflicts
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `bun run /workspace/ws-server.ts ${port}`
        })
      });
      expect(startResponse.status).toBe(200);
      const processData = (await startResponse.json()) as Process;

      // Wait for startup
      await new Promise((r) => setTimeout(r, 1000));

      // Expose port
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ port, name: 'ws-test' })
      });
      expect(exposeResponse.status).toBe(200);
      const exposeData = (await exposeResponse.json()) as PortExposeResult;

      // Connect WebSocket
      const wsUrl = exposeData.url.replace(/^http/, 'ws');
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 10000);
      });

      // Echo test
      const testMessage = 'WebSocket via exposed port!';
      const messagePromise = new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Echo timeout')), 5000);
      });
      ws.send(testMessage);
      expect(await messagePromise).toBe(testMessage);

      // Cleanup
      ws.close();
      await fetch(`${workerUrl}/api/process/${processData.id}`, {
        method: 'DELETE',
        headers
      });
      await fetch(`${workerUrl}/api/exposed-ports/${port}`, {
        method: 'DELETE',
        headers
      });
    }, 30000);
  });
});
