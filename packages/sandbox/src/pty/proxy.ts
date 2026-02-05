import { switchPort } from '@cloudflare/containers';
import type { PtyOptions } from '@repo/shared';

export async function proxyTerminal(
  stub: { fetch: (request: Request) => Promise<Response> },
  sessionId: string,
  request: Request,
  options?: PtyOptions
): Promise<Response> {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required for terminal access');
  }

  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    throw new Error('terminal() requires a WebSocket upgrade request');
  }

  const params = new URLSearchParams({ sessionId });
  if (options?.cols) params.set('cols', String(options.cols));
  if (options?.rows) params.set('rows', String(options.rows));

  const ptyUrl = `http://localhost/ws/pty?${params}`;
  const ptyRequest = new Request(ptyUrl, request);

  return stub.fetch(switchPort(ptyRequest, 3000));
}
