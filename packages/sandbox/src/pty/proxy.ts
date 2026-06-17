import { switchPort } from '@cloudflare/containers';
import type {
  SandboxTerminal,
  TerminalConnectOptions,
  TerminalCreateOptions,
  TerminalOptions
} from '@repo/shared';

interface SandboxTerminalStub {
  fetch(request: Request): Promise<Response>;
  createTerminal(options: TerminalCreateOptions): Promise<unknown>;
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

  const createOptions: TerminalCreateOptions = { id: terminalId };
  if (options?.cwd !== undefined) createOptions.cwd = options.cwd;
  if (options?.shell !== undefined) createOptions.shell = options.shell;
  if (connectOptions?.cols !== undefined)
    createOptions.cols = connectOptions.cols;
  if (connectOptions?.rows !== undefined)
    createOptions.rows = connectOptions.rows;
  await stub.createTerminal(createOptions);

  const params = new URLSearchParams({ terminalId });
  if (connectOptions?.cols) params.set('cols', String(connectOptions.cols));
  if (connectOptions?.rows) params.set('rows', String(connectOptions.rows));

  const terminalURL = `http://localhost/ws/terminal?${params}`;
  const terminalRequest = new Request(terminalURL, request);

  return stub.fetch(switchPort(terminalRequest, 3000));
}
