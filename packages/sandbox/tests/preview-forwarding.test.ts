import { describe, expect, it, vi } from 'vitest';
import {
  forwardPreviewRequest,
  type PreviewForwardingLifecycle
} from '../src/preview-forwarding';

function createLifecycle() {
  const settle = vi.fn();
  const lifecycle: PreviewForwardingLifecycle = {
    beginForward: vi.fn(() => settle),
    renewActivity: vi.fn()
  };
  return { lifecycle, settle };
}

describe('forwardPreviewRequest', () => {
  it('forwards HTTP requests through the provided TCP port', async () => {
    const { lifecycle, settle } = createLifecycle();
    const tcpFetch = vi.fn().mockResolvedValue(new Response('ok'));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/path?x=1'),
      lifecycle
    );

    expect(result.status).toBe('response');
    if (result.status === 'response') {
      expect(await result.response.text()).toBe('ok');
    }
    expect(tcpFetch).toHaveBeenCalledWith(
      'http://localhost:8080/path?x=1',
      expect.any(Request)
    );
    expect(lifecycle.beginForward).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settles after streamed HTTP body completion', async () => {
    const { lifecycle, settle } = createLifecycle();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      }
    });
    const tcpFetch = vi.fn().mockResolvedValue(new Response(stream));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/stream'),
      lifecycle
    );

    expect(result.status).toBe('response');
    expect(settle).not.toHaveBeenCalled();
    if (result.status === 'response') {
      expect(await result.response.text()).toBe('streamed');
    }
    await Promise.resolve();
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('classifies network-loss errors', async () => {
    const { lifecycle, settle } = createLifecycle();
    const tcpFetch = vi
      .fn()
      .mockRejectedValue(new Error('Network connection lost.'));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/'),
      lifecycle
    );

    expect(result).toEqual({ status: 'network-lost' });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settles and rethrows generic errors', async () => {
    const { lifecycle, settle } = createLifecycle();
    const tcpFetch = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      forwardPreviewRequest(
        { fetch: tcpFetch },
        new Request('http://localhost:8080/'),
        lifecycle
      )
    ).rejects.toThrow('boom');
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('bridges WebSocket responses and settles once on close', async () => {
    const { lifecycle, settle } = createLifecycle();
    const pair = new WebSocketPair();
    const [containerClient, containerServer] = Object.values(pair);
    const tcpFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 101, webSocket: containerClient })
      );

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/ws', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' }
      }),
      lifecycle
    );

    expect(result.status).toBe('response');
    if (result.status !== 'response') {
      throw new Error('Expected WebSocket response');
    }
    expect(result.response.status).toBe(101);
    expect(result.response.webSocket).not.toBeNull();

    const clientSocket = result.response.webSocket;
    if (!clientSocket) {
      throw new Error('Expected client WebSocket');
    }
    clientSocket.accept();
    containerServer.accept();
    clientSocket.close(1000, 'done');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
