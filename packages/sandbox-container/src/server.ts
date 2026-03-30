import { createLogger } from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import { serve } from 'bun';
import { type BunWebSocketTransport, newBunWebSocketRpcSession } from 'capnweb';
import { Container } from './core/container';
import type { PtyWSData } from './handlers/pty-ws-handler';
import { SandboxRPCAPI } from './rpc/sandbox-api';

export type CapnwebWSData = {
  type: 'capnweb';
  connectionId: string;
  transport?: BunWebSocketTransport;
};

export type WSData = PtyWSData | CapnwebWSData;

const logger = createLogger({ component: 'container' });
const SERVER_PORT = 3000;

let connectionCounter = 0;
function generateConnectionId(): string {
  return `conn-${++connectionCounter}-${Date.now().toString(36)}`;
}

// Global error handlers to prevent fragmented stack traces in logs
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled rejection', error);
  process.exit(1);
});

export interface ServerInstance {
  port: number;
  cleanup: () => Promise<void>;
}

async function createApplication(): Promise<{
  fetch: (
    req: Request,
    server: ReturnType<typeof serve<WSData>>
  ) => Promise<Response>;
  container: Container;
  rpcAPI: SandboxRPCAPI;
}> {
  const container = new Container();
  await container.initialize();

  const rpcAPI = new SandboxRPCAPI({
    processService: container.get('processService'),
    fileService: container.get('fileService'),
    portService: container.get('portService'),
    gitService: container.get('gitService'),
    interpreterService: container.get('interpreterService'),
    backupService: container.get('backupService'),
    desktopService: container.get('desktopService'),
    watchService: container.get('watchService'),
    sessionManager: container.get('sessionManager'),
    logger
  });

  return {
    fetch: async (
      req: Request,
      server: ReturnType<typeof serve<WSData>>
    ): Promise<Response> => {
      const url = new URL(req.url);
      const upgradeHeader = req.headers.get('Upgrade');

      if (upgradeHeader?.toLowerCase() === 'websocket') {
        if (url.pathname === '/ws/pty') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) {
            return new Response('sessionId query parameter required', {
              status: 400
            });
          }

          const colsParam = url.searchParams.get('cols');
          const rowsParam = url.searchParams.get('rows');
          const shellParam = url.searchParams.get('shell');

          const upgraded = server.upgrade(req, {
            data: {
              type: 'pty' as const,
              sessionId,
              connectionId: generateConnectionId(),
              cols: colsParam ? Number.parseInt(colsParam, 10) : undefined,
              rows: rowsParam ? Number.parseInt(rowsParam, 10) : undefined,
              shell: shellParam ?? undefined
            }
          });
          if (upgraded) {
            return undefined as unknown as Response;
          }
          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        if (url.pathname === '/capnweb') {
          const upgraded = server.upgrade(req, {
            data: {
              type: 'capnweb' as const,
              connectionId: generateConnectionId()
            }
          });
          if (upgraded) {
            return undefined as unknown as Response;
          }
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
      }

      // Health check endpoint
      if (url.pathname === '/health' || url.pathname === '/api/health') {
        return new Response(
          JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString()
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not Found', { status: 404 });
    },
    container,
    rpcAPI
  };
}

/**
 * Start the container server on port 3000.
 * Exposes a capnweb RPC endpoint at /capnweb and PTY WebSocket at /ws/pty.
 */
export async function startServer(): Promise<ServerInstance> {
  const app = await createApplication();

  serve<WSData>({
    idleTimeout: 255,
    fetch: (req, server) => app.fetch(req, server),
    error(error) {
      logger.error(
        'Unhandled server error',
        error instanceof Error ? error : new Error(String(error))
      );
      return new Response('Internal Server Error', { status: 500 });
    },
    hostname: '0.0.0.0',
    port: SERVER_PORT,
    websocket: {
      open(ws) {
        try {
          if (ws.data.type === 'pty') {
            void app.container
              .get('ptyWsHandler')
              .onOpen(ws as ServerWebSocket<PtyWSData>)
              .catch((err) => {
                logger.error(
                  'PTY onOpen failed',
                  err instanceof Error ? err : new Error(String(err))
                );
                try {
                  ws.close(1011, 'Internal error');
                } catch {}
              });
          } else if (ws.data.type === 'capnweb') {
            const { transport } = newBunWebSocketRpcSession(ws, app.rpcAPI);
            ws.data.transport = transport;
          }
        } catch (error) {
          logger.error(
            'Error in WebSocket open handler',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
      close(ws, code, reason) {
        try {
          if (ws.data.type === 'pty') {
            app.container
              .get('ptyWsHandler')
              .onClose(ws as ServerWebSocket<PtyWSData>, code, reason);
          } else if (ws.data.type === 'capnweb') {
            ws.data.transport?.dispatchClose(code, reason);
          }
        } catch (error) {
          logger.error(
            'Error in WebSocket close handler',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
      async message(ws, message) {
        try {
          if (ws.data.type === 'pty') {
            app.container
              .get('ptyWsHandler')
              .onMessage(ws as ServerWebSocket<PtyWSData>, message);
          } else if (ws.data.type === 'capnweb') {
            ws.data.transport?.dispatchMessage(message);
          }
        } catch (error) {
          logger.error(
            'Error in WebSocket message handler',
            error instanceof Error ? error : new Error(String(error))
          );
          try {
            ws.close(1011, 'Internal error');
          } catch {
            // Ignored - connection already closed
          }
        }
      }
    }
  });

  logger.info('Container server started', {
    port: SERVER_PORT,
    hostname: '0.0.0.0'
  });

  return {
    port: SERVER_PORT,
    cleanup: async () => {
      if (!app.container.isInitialized()) return;

      try {
        const desktopService = app.container.get('desktopService');
        const processService = app.container.get('processService');
        const portService = app.container.get('portService');
        const watchService = app.container.get('watchService');

        const stoppedWatches = await watchService.stopAllWatches();
        if (stoppedWatches > 0) {
          logger.info('Stopped file watches during shutdown', {
            count: stoppedWatches
          });
        }

        await desktopService.destroy();
        await processService.destroy();
        portService.destroy();

        logger.info('Services cleaned up successfully');
      } catch (error) {
        logger.error(
          'Error during cleanup',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  };
}

let shutdownRegistered = false;

export function registerShutdownHandlers(cleanup: () => Promise<void>): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully');
    await cleanup();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully');
    process.emit('SIGTERM');
  });
}
