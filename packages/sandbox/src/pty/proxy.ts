import { switchPort } from '@cloudflare/containers';
import type {
  SandboxTerminal,
  TerminalConnectOptions,
  TerminalOptions
} from '@repo/shared';

interface SandboxTerminalStub {
  fetch(request: Request): Promise<Response>;
  destroyTerminal(id: string): Promise<void>;
}

function resolveTerminalId(options?: TerminalOptions): string {
  if (options?.id !== undefined) {
    if (typeof options.id !== 'string' || options.id.length === 0) {
      throw new Error('terminal id must be a non-empty string');
    }

    return options.id;
  }

  return `terminal-${crypto.randomUUID()}`;
}

export function createSandboxTerminal(
  stub: SandboxTerminalStub,
  options?: TerminalOptions
): SandboxTerminal {
  const id = resolveTerminalId(options);

  return {
    id,
    connect: (request, connectOptions) =>
      proxyTerminal(stub, id, request, options, connectOptions),
    destroy: () => stub.destroyTerminal(id)
  };
}

export async function proxyTerminal(
  stub: SandboxTerminalStub,
  terminalId: string,
  request: Request,
  options?: TerminalOptions,
  connectOptions?: TerminalConnectOptions
): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    throw new Error('terminal.connect() requires a WebSocket upgrade request');
  }

  const params = new URLSearchParams({ terminalId });
  if (connectOptions?.cols) params.set('cols', String(connectOptions.cols));
  if (connectOptions?.rows) params.set('rows', String(connectOptions.rows));
  if (options?.shell) params.set('shell', options.shell);
  if (options?.cwd) params.set('cwd', options.cwd);

  const terminalURL = `http://localhost/ws/terminal?${params}`;
  const terminalRequest = new Request(terminalURL, request);

  return stub.fetch(switchPort(terminalRequest, 3000));
}
