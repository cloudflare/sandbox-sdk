import { switchPort } from '@cloudflare/containers';
import type { TerminalOptions } from '@repo/shared';

function resolveTerminal(options?: TerminalOptions): {
  id: string;
  ephemeral: boolean;
} {
  if (options?.id !== undefined) {
    if (typeof options.id !== 'string' || options.id.length === 0) {
      throw new Error('terminal id must be a non-empty string');
    }

    return { id: options.id, ephemeral: false };
  }

  return { id: `terminal-${crypto.randomUUID()}`, ephemeral: true };
}

export async function proxyTerminal(
  stub: { fetch: (request: Request) => Promise<Response> },
  request: Request,
  options?: TerminalOptions
): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    throw new Error('terminal() requires a WebSocket upgrade request');
  }

  const terminal = resolveTerminal(options);
  const params = new URLSearchParams({ terminalId: terminal.id });
  if (terminal.ephemeral) params.set('ephemeral', '1');
  if (options?.cols) params.set('cols', String(options.cols));
  if (options?.rows) params.set('rows', String(options.rows));
  if (options?.shell) params.set('shell', options.shell);
  if (options?.cwd) params.set('cwd', options.cwd);

  const terminalURL = `http://localhost/ws/terminal?${params}`;
  const terminalRequest = new Request(terminalURL, request);

  return stub.fetch(switchPort(terminalRequest, 3000));
}
