/**
 * Reproduces the production stack trace where translateRPCError() throws a
 * SyntaxError because the underlying capnweb error message is a transport-
 * level string ("WebSocket connection failed", "Peer closed WebSocket: ...")
 * rather than the JSON-encoded structured error format the container emits.
 *
 * We stand up a minimal Bun WebSocket server hosting a capnweb session,
 * connect a client, start an in-flight RPC call, then forcibly tear down the
 * server. Whatever error the client surfaces is what hits translateRPCError
 * in production.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';
import { newBunWebSocketRpcSession } from '../../src/lib/capnweb-bun';

class TestAPI extends RpcTarget {
  /** Long-running call: never resolves on its own. The test tears down the
   *  server while this is in flight and observes the resulting client error. */
  async hang(): Promise<string> {
    return new Promise(() => {});
  }

  async ping(): Promise<string> {
    return 'pong';
  }
}

interface ServerHandle {
  url: string;
  stop: (closeActiveConnections?: boolean) => Promise<void>;
}

interface TestWSData {
  transport?: {
    dispatchMessage: (m: string | Buffer) => void;
    dispatchClose: (c: number, r: string) => void;
  };
}

function startServer(): ServerHandle {
  const server = Bun.serve<TestWSData>({
    port: 0,
    fetch(req, srv) {
      if (req.headers.get('upgrade') === 'websocket') {
        if (srv.upgrade(req, { data: {} as TestWSData })) {
          return undefined as unknown as Response;
        }
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        const { transport } = newBunWebSocketRpcSession(ws, new TestAPI());
        ws.data.transport = transport as unknown as TestWSData['transport'];
      },
      message(ws, message) {
        ws.data.transport?.dispatchMessage(message);
      },
      close(ws, code, reason) {
        ws.data.transport?.dispatchClose(code, reason);
      }
    }
  });
  return {
    url: `ws://localhost:${server.port}/`,
    stop: async (closeActive = true) => {
      server.stop(closeActive);
    }
  };
}

describe('capnweb client error surface on WebSocket termination', () => {
  let server: ServerHandle | null = null;

  afterEach(async () => {
    await server?.stop(true);
    server = null;
  });

  it('surfaces a transport-level Error (not a JSON-encoded SandboxError) when the server forcibly closes the connection mid-RPC', async () => {
    server = startServer();

    const ws = new WebSocket(server.url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener(
        'error',
        () => reject(new Error('failed to open ws')),
        { once: true }
      );
    });

    const stub = newWebSocketRpcSession<TestAPI>(ws as unknown as WebSocket);

    // Sanity: a normal call completes successfully.
    expect(await stub.ping()).toBe('pong');

    // Start a never-resolving call.
    const inflight = stub.hang();

    // Give the RPC message a tick to leave the queue and reach the server.
    await new Promise((r) => setTimeout(r, 10));

    // Forcibly tear down the server, closing the active socket.
    await server.stop(true);

    let err: unknown;
    try {
      await inflight;
    } catch (e) {
      err = e;
    }

    // What we actually observe:
    //  - error is an Error instance
    //  - error.message is a transport-level human string ("Peer closed
    //    WebSocket: ..." or "WebSocket connection failed"), NOT JSON
    //  - JSON.parse(error.message) would throw SyntaxError, exactly as seen
    //    in the production logs
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
    expect(() => JSON.parse(message)).toThrow();
    expect(
      message.includes('WebSocket') ||
        message.includes('closed') ||
        message.includes('failed')
    ).toBe(true);
  });
});
