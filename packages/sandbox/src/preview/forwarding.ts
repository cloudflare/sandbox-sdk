import { ErrorCode, OperationInterruptedError } from '../errors';
import type { RuntimeLease } from '../runtime';

export type PreviewTCPPort = {
  fetch(
    input: Request | string,
    init?: Request | RequestInit
  ): Promise<Response>;
};

export type PreviewForwardingLease = Pick<RuntimeLease, 'retain'>;

export type PreviewForwardingResult =
  | { status: 'response'; response: Response }
  | { status: 'network-lost' };

export async function forwardPreviewRequest(
  tcpPort: PreviewTCPPort,
  request: Request,
  lease: PreviewForwardingLease
): Promise<PreviewForwardingResult> {
  const containerURL = request.url.replace('https:', 'http:');
  let interruptedError: OperationInterruptedError | undefined;
  let closeAssignedResponse:
    | ((error: OperationInterruptedError) => void)
    | undefined;
  const hold = lease.retain(() => {
    interruptedError = previewForwardInterrupted();
    closeAssignedResponse?.(interruptedError);
  });
  const release = once(() => hold.release());
  if (interruptedError) {
    release();
    throw interruptedError;
  }

  try {
    const response = await tcpPort.fetch(containerURL, request);
    if (interruptedError) {
      closeLateResponse(response, interruptedError);
      throw interruptedError;
    }

    if (response.webSocket !== null) {
      return {
        status: 'response',
        response: bridgePreviewWebSocket(response, release, (close) => {
          closeAssignedResponse = close;
          if (interruptedError) close(interruptedError);
        })
      };
    }

    if (response.body !== null) {
      const retained = retainPreviewBody(response.body, release, (close) => {
        closeAssignedResponse = close;
        if (interruptedError) close(interruptedError);
      });
      return {
        status: 'response',
        response: new Response(retained, response)
      };
    }

    release();
    return { status: 'response', response };
  } catch (error) {
    release();
    if (
      error instanceof Error &&
      error.message.includes('Network connection lost.')
    ) {
      return { status: 'network-lost' };
    }
    throw error;
  }
}

function retainPreviewBody(
  body: ReadableStream<Uint8Array>,
  release: () => void,
  bindInterrupt: (close: (error: OperationInterruptedError) => void) => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let interruptedError: OperationInterruptedError | undefined;
  let sourceCancelled = false;
  const cancelSource = (reason?: unknown) => {
    if (sourceCancelled) return;
    sourceCancelled = true;
    release();
    void reader.cancel(reason).catch(() => undefined);
  };
  const fail = once((error: OperationInterruptedError) => {
    interruptedError = error;
    controller?.error(error);
    cancelSource(error);
  });
  bindInterrupt(fail);

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (interruptedError) streamController.error(interruptedError);
    },
    async pull(streamController) {
      try {
        if (interruptedError) throw interruptedError;
        const result = await reader.read();
        if (interruptedError) throw interruptedError;
        if (result.done) {
          release();
          streamController.close();
          return;
        }
        streamController.enqueue(result.value);
      } catch (error) {
        release();
        if (error !== interruptedError) {
          streamController.error(error);
        }
      }
    },
    cancel(reason) {
      cancelSource(reason);
    }
  });
}

function bridgePreviewWebSocket(
  response: Response,
  release: () => void,
  bindInterrupt: (close: (error: OperationInterruptedError) => void) => void
): Response {
  const containerWebSocket = response.webSocket;
  if (containerWebSocket === null) {
    release();
    return response;
  }

  const [client, server] = Object.values(new WebSocketPair());
  let settled = false;
  const settle = once(() => {
    settled = true;
    release();
  });
  const closeInterrupted = once(() => {
    try {
      containerWebSocket.close(1012, 'Runtime replaced');
      server.close(1012, 'Runtime replaced');
    } finally {
      settle();
    }
  });
  bindInterrupt(closeInterrupted);

  containerWebSocket.accept();
  server.accept();

  server.addEventListener('message', async (event) => {
    if (settled) return;
    try {
      const data =
        event.data instanceof Blob
          ? await event.data.arrayBuffer()
          : event.data;
      containerWebSocket.send(data);
    } catch {
      server.close(1011, 'Failed to forward message to container');
    }
  });

  containerWebSocket.addEventListener('message', async (event) => {
    if (settled) return;
    try {
      const data =
        event.data instanceof Blob
          ? await event.data.arrayBuffer()
          : event.data;
      server.send(data);
    } catch {
      containerWebSocket.close(1011, 'Failed to forward message to client');
    }
  });

  server.addEventListener('close', (event) => {
    settle();
    const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
    containerWebSocket.close(code, event.reason);
  });

  containerWebSocket.addEventListener('close', (event) => {
    settle();
    const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
    server.close(code, event.reason);
  });

  server.addEventListener('error', () => {
    settle();
    containerWebSocket.close(1011, 'Client WebSocket error');
  });

  containerWebSocket.addEventListener('error', () => {
    settle();
    server.close(1011, 'Container WebSocket error');
  });

  return new Response(null, {
    status: response.status,
    webSocket: client,
    headers: response.headers
  });
}

function closeLateResponse(
  response: Response,
  error: OperationInterruptedError
): void {
  if (response.webSocket !== null) {
    try {
      response.webSocket.accept();
    } catch {
      // The socket may already be accepted by the platform.
    }
    response.webSocket.close(1012, 'Runtime replaced');
    return;
  }
  void response.body?.cancel(error).catch(() => undefined);
}

function previewForwardInterrupted(): OperationInterruptedError {
  return new OperationInterruptedError({
    code: ErrorCode.OPERATION_INTERRUPTED,
    message:
      'Sandbox operation preview.forward was interrupted because the runtime changed',
    context: {
      reason: 'runtime_replaced',
      operation: 'preview.forward',
      admitted: true,
      retryable: false
    },
    httpStatus: 409,
    timestamp: new Date().toISOString()
  });
}

function once<T extends (...args: never[]) => void>(fn: T): T {
  let called = false;
  return ((...args: Parameters<T>) => {
    if (called) return;
    called = true;
    fn(...(args as never[]));
  }) as T;
}
