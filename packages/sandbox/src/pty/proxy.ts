import { switchPort } from '@cloudflare/containers';
import type {
  CreateTerminalOptions,
  ErrorResponse,
  ProcessExit,
  Terminal,
  TerminalOutputCursor,
  TerminalOutputEvent,
  TerminalOutputOptions,
  TerminalOutputSubscriptionAPI,
  TerminalSnapshot,
  WaitForExitOptions
} from '@repo/shared';
import {
  ErrorCode,
  type TerminalControlErrorContext
} from '@repo/shared/errors';
import { TerminalControlError } from '../errors';
import { openRemoteSubscription } from '../processes/remote-subscription';
import type { ProcessPullSubscriptionRPC } from '../processes/rpc-types';
import type { TerminalRPCDescriptor } from './rpc-types';

interface TerminalHandleStub {
  get(id: string): Promise<TerminalSnapshot | null>;
  output(
    id: string,
    options?: Omit<TerminalOutputOptions, 'signal'>
  ): Promise<
    | TerminalOutputSubscriptionAPI
    | ProcessPullSubscriptionRPC<TerminalOutputEvent>
  >;
  write(id: string, data: Uint8Array): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  interrupt(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

interface SandboxTerminalStub extends TerminalHandleStub {
  create(options: CreateTerminalOptions): Promise<TerminalSnapshot>;
  list(): Promise<TerminalSnapshot[]>;
}

export async function createTerminalHandle(
  stub: SandboxTerminalStub,
  options: CreateTerminalOptions
): Promise<Terminal> {
  return terminalHandle(stub, await stub.create(options));
}

export async function getTerminalHandle(
  stub: SandboxTerminalStub,
  id: string
): Promise<Terminal | null> {
  const snapshot = await stub.get(id);
  return snapshot ? terminalHandle(stub, snapshot) : null;
}

export async function listTerminalHandles(
  stub: SandboxTerminalStub
): Promise<Terminal[]> {
  return Promise.all(
    (await stub.list()).map((snapshot) => terminalHandle(stub, snapshot))
  );
}

export function terminalHandle(
  stub: TerminalHandleStub,
  snapshot: TerminalSnapshot,
  runtimeIncarnationID?: string,
  outputProtocol: 'stream' | 'pull' = 'stream'
): Terminal {
  const id = snapshot.id;
  return {
    id,
    getSnapshot: async () => {
      const current = await stub.get(id);
      if (!current) throw new Error(`Terminal not found: ${id}`);
      return current;
    },
    write: (data) => stub.write(id, data),
    resize: (cols, rows) => stub.resize(id, cols, rows),
    output: (options) => terminalOutput(stub, id, options, outputProtocol),
    waitForExit: (options) =>
      waitForTerminalExit(stub, id, options, outputProtocol),
    interrupt: () => stub.interrupt(id),
    terminate: () => stub.terminate(id),
    connect: (request, options) => {
      if (!runtimeIncarnationID) {
        throw new Error('terminal.connect() requires a runtime incarnation ID');
      }
      return proxyTerminal(stub, id, request, {
        ...options,
        runtimeIncarnationID
      });
    }
  };
}

export function terminalHandleFromRPCDescriptor(
  descriptor: TerminalRPCDescriptor,
  fetch: (request: Request) => Promise<Response>
): Terminal {
  const capability = descriptor.capability;
  const stub: TerminalHandleStub = {
    get: () => capability.getSnapshot(),
    output: (_id, options) => capability.openOutput(options),
    write: (_id, data) => capability.write(data),
    resize: (_id, cols, rows) => capability.resize(cols, rows),
    interrupt: () => capability.interrupt(),
    terminate: () => capability.terminate(),
    fetch
  };
  return terminalHandle(
    stub,
    descriptor.snapshot,
    descriptor.runtimeIncarnationID,
    'pull'
  );
}

async function terminalOutput(
  stub: TerminalHandleStub,
  id: string,
  options: TerminalOutputOptions | undefined,
  protocol: 'stream' | 'pull'
) {
  const { signal, ...rpcOptions } = options ?? {};
  const stream = await openRemoteSubscription<TerminalOutputEvent>(
    stub.output(id, rpcOptions),
    { operation: 'open terminal output', protocol, signal }
  );
  if (!signal) return stream;
  let reader: ReadableStreamDefaultReader<TerminalOutputEvent> | undefined;
  return new ReadableStream({
    start(controller) {
      const activeReader = stream.getReader();
      reader = activeReader;
      let settled = false;
      const close = () => {
        if (settled) return;
        settled = true;
        controller.close();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        controller.error(error);
      };
      const abort = () => {
        activeReader.cancel().catch(() => {});
        close();
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      void (async () => {
        try {
          while (!signal.aborted) {
            const result = await activeReader.read();
            if (result.done) break;
            controller.enqueue(result.value);
          }
          close();
        } catch (error) {
          fail(error);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      })();
    },
    cancel() {
      return reader?.cancel();
    }
  });
}

async function waitForTerminalExit(
  stub: TerminalHandleStub,
  id: string,
  options: WaitForExitOptions = {},
  protocol: 'stream' | 'pull'
): Promise<ProcessExit> {
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortedBySignal = false;
  const abort = () => {
    if (abortController.signal.aborted) return;
    abortedBySignal = true;
    abortController.abort(options.signal?.reason);
  };
  const timeoutAbort = () => {
    if (abortController.signal.aborted) return;
    abortController.abort(new Error('Terminal wait timed out'));
  };
  if (options.signal) {
    if (options.signal.aborted) throw abortReason(options.signal.reason);
    options.signal.addEventListener('abort', abort, { once: true });
  }
  if (options.timeout !== undefined)
    timeout = setTimeout(timeoutAbort, options.timeout);
  let reader: ReadableStreamDefaultReader<TerminalOutputEvent> | undefined;
  try {
    const stream = await openRemoteSubscription<TerminalOutputEvent>(
      stub.output(id, { replay: true, follow: true }),
      {
        operation: 'wait for terminal exit',
        protocol,
        signal: abortController.signal
      }
    );
    reader = stream.getReader();
    abortController.signal.addEventListener(
      'abort',
      () => {
        void reader?.cancel().catch(() => {});
      },
      { once: true }
    );
    while (!abortController.signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.type === 'terminal') {
        if (result.value.state === 'exited') return result.value.exit;
        throw terminalRuntimeError(id, result.value);
      }
    }
    if (abortController.signal.aborted) {
      throw abortedBySignal
        ? abortReason(abortController.signal.reason)
        : new Error('Terminal wait timed out');
    }
    throw new Error('Terminal wait aborted');
  } finally {
    if (timeout) clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {});
  }
}

function terminalRuntimeError(
  terminalId: string,
  failure: TerminalOutputEvent & { type: 'terminal'; state: 'error' }
): TerminalControlError {
  const context: TerminalControlErrorContext = {
    terminalId,
    operation: 'waitForExit',
    reason: failure.error.message,
    failure: { ...failure.error }
  };
  const response: ErrorResponse<TerminalControlErrorContext> = {
    code: ErrorCode.TERMINAL_CONTROL_ERROR,
    message: failure.error.message,
    context,
    httpStatus: 500,
    timestamp: failure.timestamp
  };
  return new TerminalControlError(response);
}

function abortReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (reason === undefined) return new Error('Terminal wait aborted');
  return new Error(String(reason));
}

export async function proxyTerminal(
  stub: Pick<TerminalHandleStub, 'fetch'>,
  terminalId: string,
  request: Request,
  options: {
    cursor?: TerminalOutputCursor;
    cols?: number;
    rows?: number;
    runtimeIncarnationID: string;
  }
): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket')
    throw new Error('terminal.connect() requires a WebSocket upgrade request');
  const params = new URLSearchParams({ terminalId });
  if (!options.runtimeIncarnationID) {
    throw new Error('terminal.connect() requires a runtime incarnation ID');
  }
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.cols) params.set('cols', String(options.cols));
  if (options.rows) params.set('rows', String(options.rows));
  params.set('runtimeIncarnationID', options.runtimeIncarnationID);
  return stub.fetch(
    switchPort(
      new Request(`http://localhost/ws/terminal?${params}`, request),
      3000
    )
  );
}
