import { beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { getSharedSandbox } from './helpers/global-sandbox';

describe('PTY', () => {
  let workerUrl: string;
  let sandboxId: string;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    sandboxId = sandbox.sandboxId;
  }, 120000);

  async function connectWebSocket(sessionId?: string): Promise<{
    ws: WebSocket;
    output: string[];
  }> {
    const path = sessionId ? `/terminal/${sessionId}` : '/terminal';
    const wsUrl = `${workerUrl.replace(/^http/, 'ws')}${path}?sandboxId=${sandboxId}`;
    const ws = new WebSocket(wsUrl);
    const output: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('WebSocket connection timeout')),
        15000
      );

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          output.push((data as Buffer).toString('utf-8'));
        } else {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'ready') {
              clearTimeout(timeout);
              resolve();
            }
          } catch {
            // Ignore non-JSON text messages
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return { ws, output };
  }

  async function waitForOutput(
    output: string[],
    pattern: string,
    timeoutMs = 5000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (output.join('').includes(pattern)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `Timeout waiting for "${pattern}". Got: ${output.join('').slice(-200)}`
    );
  }

  /**
   * Uses terminate() instead of close() because WebSocket close events don't
   * propagate correctly in local dev (workerd issue with container WebSocket coupling).
   * Production works correctly. For functional tests, terminate() is appropriate.
   */
  function cleanup(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  }

  describe('Basic Operations', () => {
    test('executes command and receives output', async () => {
      const { ws, output } = await connectWebSocket();

      const marker = `pty-exec-${Date.now()}`;
      ws.send(Buffer.from(`echo "${marker}"\n`));

      await waitForOutput(output, marker);
      expect(output.join('')).toContain(marker);

      cleanup(ws);
    }, 30000);

    test('handles resize control messages', async () => {
      const { ws, output } = await connectWebSocket();

      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      output.length = 0;
      ws.send(Buffer.from('stty size\n'));

      await waitForOutput(output, '40 120');
      expect(output.join('')).toContain('40 120');

      cleanup(ws);
    }, 30000);
  });

  describe('Connection Lifecycle', () => {
    test('replays buffered output on reconnect', async () => {
      const sessionId = `pty-reconnect-${Date.now()}`;
      const marker = `reconnect-marker-${Date.now()}`;

      // First connection: run command that produces output
      const { ws: ws1, output: output1 } = await connectWebSocket(sessionId);
      ws1.send(Buffer.from(`echo "${marker}"\n`));
      await waitForOutput(output1, marker);
      cleanup(ws1);

      // Second connection: should receive buffered output
      const { ws: ws2, output: output2 } = await connectWebSocket(sessionId);

      // Buffered output is sent before 'ready', so it should already be there
      expect(output2.join('')).toContain(marker);

      cleanup(ws2);
    }, 30000);

    test('broadcasts output to multiple concurrent connections', async () => {
      const sessionId = `pty-multi-${Date.now()}`;
      const marker = `multi-marker-${Date.now()}`;

      // Open two connections to the same session
      const { ws: ws1, output: output1 } = await connectWebSocket(sessionId);
      const { ws: ws2, output: output2 } = await connectWebSocket(sessionId);

      // Clear any buffered output from connection setup
      output1.length = 0;
      output2.length = 0;

      // Send command on first connection
      ws1.send(Buffer.from(`echo "${marker}"\n`));

      // Both connections should receive the output
      await waitForOutput(output1, marker);
      await waitForOutput(output2, marker);

      expect(output1.join('')).toContain(marker);
      expect(output2.join('')).toContain(marker);

      cleanup(ws1);
      cleanup(ws2);
    }, 30000);
  });

  describe('Session Isolation', () => {
    test('different sessions have independent PTYs', async () => {
      const sessionA = `pty-iso-a-${Date.now()}`;
      const sessionB = `pty-iso-b-${Date.now()}`;
      const markerA = `marker-a-${Date.now()}`;

      // Session A: set environment variable
      const { ws: wsA, output: outputA } = await connectWebSocket(sessionA);
      wsA.send(Buffer.from(`export PTY_TEST_VAR="${markerA}"\n`));
      wsA.send(Buffer.from(`echo "set:$PTY_TEST_VAR"\n`));
      await waitForOutput(outputA, `set:${markerA}`);

      // Session B: should NOT see session A's variable
      const { ws: wsB, output: outputB } = await connectWebSocket(sessionB);
      wsB.send(Buffer.from(`echo "check:$PTY_TEST_VAR"\n`));

      // Wait for the echo command to complete
      await waitForOutput(outputB, 'check:');

      // Session B should have empty variable (just "check:" with nothing after)
      const outputBStr = outputB.join('');
      expect(outputBStr).toContain('check:');
      expect(outputBStr).not.toContain(markerA);

      cleanup(wsA);
      cleanup(wsB);
    }, 30000);
  });

  describe('Error Handling', () => {
    test('returns 426 for non-WebSocket request', async () => {
      const response = await fetch(`${workerUrl}/terminal`);
      expect(response.status).toBe(426);
    }, 10000);
  });
});
