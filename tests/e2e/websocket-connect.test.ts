import { beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { getSharedSandbox } from './helpers/global-sandbox';

/**
 * WebSocket Connection Tests
 *
 * Tests WebSocket routing via wsConnect(). Uses SHARED sandbox.
 */
describe('WebSocket Connections', () => {
  let workerUrl: string;
  let sandboxId: string;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    sandboxId = sandbox.sandboxId;

    // Initialize sandbox (container echo server is built-in)
    const initRes = await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers: { 'X-Sandbox-Id': sandboxId }
    });
    expect(initRes.status).toBe(200);
  }, 120000);

  test('should establish WebSocket connection and echo messages', async () => {
    const wsUrl = `${workerUrl.replace(/^http/, 'ws')}/ws/echo`;
    const ws = new WebSocket(wsUrl, {
      headers: { 'X-Sandbox-Id': sandboxId }
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    // Send and receive
    const testMessage = 'Hello WebSocket';
    const messagePromise = new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      setTimeout(() => reject(new Error('Echo timeout')), 5000);
    });
    ws.send(testMessage);

    expect(await messagePromise).toBe(testMessage);
    ws.close();
  }, 20000);

  test('should handle multiple concurrent connections', async () => {
    const wsUrl = `${workerUrl.replace(/^http/, 'ws')}/ws/echo`;

    // Open 3 connections
    const connections = [1, 2, 3].map(
      () => new WebSocket(wsUrl, { headers: { 'X-Sandbox-Id': sandboxId } })
    );

    // Wait for all to open
    await Promise.all(
      connections.map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.on('open', () => resolve());
            ws.on('error', reject);
            setTimeout(() => reject(new Error('Timeout')), 10000);
          })
      )
    );

    // Send and receive on each
    const results = await Promise.all(
      connections.map(
        (ws, i) =>
          new Promise<string>((resolve) => {
            ws.on('message', (data) => resolve(data.toString()));
            ws.send(`Message ${i + 1}`);
          })
      )
    );

    expect(results).toEqual(['Message 1', 'Message 2', 'Message 3']);

    for (const ws of connections) {
      ws.close();
    }
  }, 20000);
});
