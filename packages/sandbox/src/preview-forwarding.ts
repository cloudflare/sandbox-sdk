import { isDurableObjectReset } from './platform-errors';

export type PreviewTCPPort = {
  fetch(
    input: Request | string,
    init?: Request | RequestInit
  ): Promise<Response>;
};

export type PreviewForwardingLifecycle = {
  beginForward(): () => void;
  renewActivity(): void;
};

export type PreviewForwardingResult =
  | { status: 'response'; response: Response }
  | { status: 'network-lost' }
  | { status: 'failed'; error: unknown };

export async function forwardPreviewRequest(
  tcpPort: PreviewTCPPort,
  request: Request,
  lifecycle: PreviewForwardingLifecycle
): Promise<PreviewForwardingResult> {
  const containerURL = request.url.replace('https:', 'http:');
  const settleForward = lifecycle.beginForward();

  try {
    const response = await tcpPort.fetch(containerURL, request);

    if (response.webSocket !== null) {
      return {
        status: 'response',
        response: bridgePreviewWebSocket(response, lifecycle, settleForward)
      };
    }

    if (response.body !== null) {
      const { readable, writable } = new TransformStream();
      response.body
        .pipeTo(writable)
        .finally(settleForward)
        .catch(() => {});
      return { status: 'response', response: new Response(readable, response) };
    }

    settleForward();
    return { status: 'response', response };
  } catch (error) {
    settleForward();
    // A reset of this Durable Object is a platform interruption, not a
    // failure of the app behind the port.
    if (isDurableObjectReset(error)) throw error;
    if (
      error instanceof Error &&
      error.message.includes('Network connection lost.')
    ) {
      return { status: 'network-lost' };
    }
    return { status: 'failed', error };
  }
}

function bridgePreviewWebSocket(
  response: Response,
  lifecycle: PreviewForwardingLifecycle,
  settleForward: () => void
): Response {
  const containerWebSocket = response.webSocket;
  if (containerWebSocket === null) {
    settleForward();
    return response;
  }

  const [client, server] = Object.values(new WebSocketPair());
  let settled = false;
  const settle = () => {
    if (!settled) {
      settled = true;
      settleForward();
    }
  };

  containerWebSocket.accept();
  server.accept();

  server.addEventListener('message', async (event) => {
    lifecycle.renewActivity();
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
    lifecycle.renewActivity();
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
