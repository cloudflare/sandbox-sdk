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

  async function connectWebSocket(path = '/terminal'): Promise<{
    ws: WebSocket;
    output: string[];
  }> {
    const wsUrl = `${workerUrl.replace(/^http/, 'ws')}${path}?sandboxId=${sandboxId}`;
    const ws = new WebSocket(wsUrl);
    const output: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('WebSocket timeout')),
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
          } catch {}
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
    throw new Error(`Timeout waiting for pattern: ${pattern}`);
  }

  describe('WebSocket Terminal', () => {
    test('should execute command and receive output', async () => {
      const { ws, output } = await connectWebSocket();

      const marker = `pty-ws-test-${Date.now()}`;
      ws.send(Buffer.from(`echo "${marker}"\n`));

      await waitForOutput(output, marker);
      expect(output.join('')).toContain(marker);

      ws.close();
    }, 30000);

    test('should handle resize control messages', async () => {
      const { ws, output } = await connectWebSocket();

      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      output.length = 0;
      ws.send(Buffer.from('stty size\n'));

      await waitForOutput(output, '40 120');
      expect(output.join('')).toContain('40 120');

      ws.close();
    }, 30000);
  });

  describe('Error Handling', () => {
    test('should return 426 for non-WebSocket request to /terminal', async () => {
      const response = await fetch(`${workerUrl}/terminal`);
      expect(response.status).toBe(426);
    }, 10000);
  });
});
