import type { ISandbox } from '@cloudflare/sandbox';
import { newBunWebSocketRpcSession, type RpcPromise, RpcTarget } from 'capnweb';
import type Logger from './logger';

export interface CloudflareSandbox {
  sandbox(sessionId: string): RpcPromise<ISandbox>;
}

const { promise, resolve, reject } = Promise.withResolvers<CloudflareSandbox>();

export async function getSandbox(): Promise<CloudflareSandbox> {
  return promise;
}

export const setSandbox = resolve;

export function createRPCSocket({ logger }: { logger: Logger }) {
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 3001,

    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response('WebSocket server running', { status: 200 });
    },

    websocket: {
      open(ws) {
        const { stub, transport } = newBunWebSocketRpcSession(
          ws,
          new RpcTarget()
        );
        ws.data = { transport };
        resolve(stub as unknown as CloudflareSandbox);
      },
      message(ws, msg) {
        (ws.data as any).transport.dispatchMessage(msg);
      },
      close(ws, code, reason) {
        (ws.data as any).transport.dispatchClose(code, reason);
        reject(new Error(`WebSocket closed: code=${code} reason=${reason}`));
      },
      error(ws, err) {
        (ws.data as any).transport.dispatchError(err);
        reject(err);
      }
    }
  });

  logger.info(`WebSocket server listening on port ${server.port}`);
  return server;
}
