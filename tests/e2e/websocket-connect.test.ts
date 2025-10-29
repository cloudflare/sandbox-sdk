import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, cleanupSandbox } from './helpers/test-fixtures';

/**
 * WebSocket connect() Integration Tests
 *
 * Tests the connect() method for routing WebSocket requests to container services.
 * Focuses on transport-level functionality, not application-level server implementations.
 */
describe('WebSocket Connections', () => {
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

  test('should establish WebSocket connection to container service', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Start a simple echo server in the container
    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    // Wait for server to be ready (generous timeout for first startup)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Connect via WebSocket using connect() routing
    const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/echo';
    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Sandbox-Id': currentSandboxId,
      },
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    // Send message and verify echo back
    const testMessage = 'Hello WebSocket';
    const messagePromise = new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      setTimeout(() => reject(new Error('Echo timeout')), 5000);
    });

    ws.send(testMessage);
    const echoedMessage = await messagePromise;

    expect(echoedMessage).toBe(testMessage);

    // Clean close
    ws.close();
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      setTimeout(() => resolve(), 1000);
    });
  }, 30000);

  test('should handle multiple concurrent connections', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Initialize echo server
    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Open 3 concurrent connections to echo server
    const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/echo';
    const ws1 = new WebSocket(wsUrl, { headers: { 'X-Sandbox-Id': currentSandboxId } });
    const ws2 = new WebSocket(wsUrl, { headers: { 'X-Sandbox-Id': currentSandboxId } });
    const ws3 = new WebSocket(wsUrl, { headers: { 'X-Sandbox-Id': currentSandboxId } });

    // Wait for all connections to open
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        ws1.on('open', () => resolve());
        ws1.on('error', reject);
        setTimeout(() => reject(new Error('WS1 timeout')), 10000);
      }),
      new Promise<void>((resolve, reject) => {
        ws2.on('open', () => resolve());
        ws2.on('error', reject);
        setTimeout(() => reject(new Error('WS2 timeout')), 10000);
      }),
      new Promise<void>((resolve, reject) => {
        ws3.on('open', () => resolve());
        ws3.on('error', reject);
        setTimeout(() => reject(new Error('WS3 timeout')), 10000);
      }),
    ]);

    // Send different messages on each connection simultaneously
    const results = await Promise.all([
      new Promise<string>((resolve) => {
        ws1.on('message', (data) => resolve(data.toString()));
        ws1.send('Message 1');
      }),
      new Promise<string>((resolve) => {
        ws2.on('message', (data) => resolve(data.toString()));
        ws2.send('Message 2');
      }),
      new Promise<string>((resolve) => {
        ws3.on('message', (data) => resolve(data.toString()));
        ws3.send('Message 3');
      }),
    ]);

    // Verify each connection received its own message (no interference)
    expect(results[0]).toBe('Message 1');
    expect(results[1]).toBe('Message 2');
    expect(results[2]).toBe('Message 3');

    // Close all connections
    ws1.close();
    ws2.close();
    ws3.close();
  }, 30000);
});
