import { describe, expect, it, vi } from 'vitest';
import { OperationInterruptedError } from '../src/errors';
import {
  forwardPreviewRequest,
  type PreviewForwardingLease
} from '../src/preview/forwarding';

function createLease() {
  let interrupt: (() => void) | undefined;
  const release = vi.fn();
  const retain = vi.fn((onInterrupt?: () => void) => {
    interrupt = onInterrupt;
    return { release };
  });
  const lease: PreviewForwardingLease = { retain };
  return {
    lease,
    retain,
    release,
    interrupt: () => interrupt?.()
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('forwardPreviewRequest', () => {
  it('does not fetch when retain synchronously interrupts', async () => {
    const release = vi.fn();
    const lease: PreviewForwardingLease = {
      retain: (onInterrupt) => {
        onInterrupt?.();
        return { release };
      }
    };
    const tcpFetch = vi.fn().mockResolvedValue(new Response('late'));

    await expect(
      forwardPreviewRequest(
        { fetch: tcpFetch },
        new Request('http://localhost:8080/path'),
        lease
      )
    ).rejects.toBeInstanceOf(OperationInterruptedError);

    expect(tcpFetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('forwards HTTP requests through the provided TCP port and releases bodyless responses', async () => {
    const lease = createLease();
    const tcpFetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/path?x=1'),
      lease.lease
    );

    expect(result).toMatchObject({ status: 'response' });
    if (result.status === 'response') {
      expect(result.response.status).toBe(204);
    }
    expect(tcpFetch).toHaveBeenCalledWith(
      'http://localhost:8080/path?x=1',
      expect.any(Request)
    );
    expect(lease.retain).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('retains HTTP response bodies until EOF', async () => {
    const lease = createLease();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      }
    });
    const tcpFetch = vi.fn().mockResolvedValue(new Response(stream));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/stream'),
      lease.lease
    );

    expect(result.status).toBe('response');
    expect(lease.release).not.toHaveBeenCalled();
    if (result.status === 'response') {
      expect(await result.response.text()).toBe('streamed');
    }
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('releases and cancels HTTP response bodies on caller cancellation', async () => {
    const lease = createLease();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
      },
      cancel
    });
    const tcpFetch = vi.fn().mockResolvedValue(new Response(stream));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/stream'),
      lease.lease
    );

    if (result.status !== 'response' || !result.response.body) {
      throw new Error('Expected streaming response');
    }
    await result.response.body.cancel('caller done');

    expect(cancel).toHaveBeenCalledWith('caller done');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('errors HTTP response bodies on runtime invalidation', async () => {
    const lease = createLease();
    const bodyGate = deferred<Uint8Array>();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(await bodyGate.promise);
      },
      cancel
    });
    const tcpFetch = vi.fn().mockResolvedValue(new Response(stream));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/stream'),
      lease.lease
    );

    if (result.status !== 'response' || !result.response.body) {
      throw new Error('Expected streaming response');
    }
    const reader = result.response.body.getReader();
    const read = reader.read();
    lease.interrupt();
    bodyGate.resolve(new Uint8Array([1]));

    await expect(read).rejects.toBeInstanceOf(OperationInterruptedError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('classifies network-loss errors and releases the hold', async () => {
    const lease = createLease();
    const tcpFetch = vi
      .fn()
      .mockRejectedValue(new Error('Network connection lost.'));

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/'),
      lease.lease
    );

    expect(result).toEqual({ status: 'network-lost' });
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('releases and rethrows generic errors', async () => {
    const lease = createLease();
    const tcpFetch = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      forwardPreviewRequest(
        { fetch: tcpFetch },
        new Request('http://localhost:8080/'),
        lease.lease
      )
    ).rejects.toThrow('boom');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('closes a late WebSocket response when invalidated during fetch assignment', async () => {
    const lease = createLease();
    const pair = new WebSocketPair();
    const [containerClient] = Object.values(pair);
    const close = vi.spyOn(containerClient, 'close');
    const response = new Response(null, {
      status: 101,
      webSocket: containerClient
    });
    const pendingResponse = deferred<Response>();
    const tcpFetch = vi.fn(() => pendingResponse.promise);

    const forwarded = forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/ws'),
      lease.lease
    );
    await vi.waitFor(() => expect(lease.retain).toHaveBeenCalledOnce());
    lease.interrupt();
    pendingResponse.resolve(response);

    await expect(forwarded).rejects.toBeInstanceOf(OperationInterruptedError);
    expect(close).toHaveBeenCalledWith(1012, 'Runtime replaced');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('bridges WebSocket messages without manual renewal and releases on close', async () => {
    const lease = createLease();
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
      lease.lease
    );

    expect(result.status).toBe('response');
    if (result.status !== 'response') {
      throw new Error('Expected WebSocket response');
    }
    const clientSocket = result.response.webSocket;
    if (!clientSocket) {
      throw new Error('Expected client WebSocket');
    }
    const clientMessages: unknown[] = [];
    const containerMessages: unknown[] = [];
    clientSocket.accept();
    containerServer.accept();
    clientSocket.addEventListener('message', (event) => {
      clientMessages.push(event.data);
    });
    containerServer.addEventListener('message', (event) => {
      containerMessages.push(event.data);
    });

    clientSocket.send('to-container');
    containerServer.send('to-client');
    await nextTick();

    expect(containerMessages).toEqual(['to-container']);
    expect(clientMessages).toEqual(['to-client']);
    expect(lease.release).not.toHaveBeenCalled();

    clientSocket.close(1000, 'done');
    await nextTick();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('closes bridged WebSockets on runtime invalidation', async () => {
    const lease = createLease();
    const pair = new WebSocketPair();
    const [containerClient] = Object.values(pair);
    const containerClose = vi.spyOn(containerClient, 'close');
    const tcpFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 101, webSocket: containerClient })
      );

    const result = await forwardPreviewRequest(
      { fetch: tcpFetch },
      new Request('http://localhost:8080/ws'),
      lease.lease
    );

    if (result.status !== 'response' || !result.response.webSocket) {
      throw new Error('Expected WebSocket response');
    }
    const clientClose = new Promise<CloseEvent>((resolve) => {
      result.response.webSocket!.accept();
      result.response.webSocket!.addEventListener('close', resolve, {
        once: true
      });
    });
    lease.interrupt();

    expect(containerClose).toHaveBeenCalledWith(1012, 'Runtime replaced');
    await expect(clientClose).resolves.toMatchObject({
      code: 1012,
      reason: 'Runtime replaced'
    });
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
