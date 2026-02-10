import { createLogger } from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import { serve } from 'bun';
import { Container } from './core/container';
import { Router } from './core/router';
import type { PtyWSData } from './handlers/pty-ws-handler';
import {
  type WSData as ControlWSData,
  generateConnectionId,
  WebSocketAdapter
} from './handlers/ws-adapter';

export type WSData = (ControlWSData & { type: 'control' }) | PtyWSData;

import { setupRoutes } from './routes/setup';

const logger = createLogger({ component: 'container' });
const SERVER_PORT = 3000;

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
  wsAdapter: WebSocketAdapter;
}> {
  const container = new Container();
  await container.initialize();

  const router = new Router(logger);
  router.use(container.get('corsMiddleware'));
  setupRoutes(router, container);

  // Create WebSocket adapter with the router for control plane multiplexing
  const wsAdapter = new WebSocketAdapter(router, logger);

  return {
    fetch: async (
      req: Request,
      server: ReturnType<typeof serve<WSData>>
    ): Promise<Response> => {
      const upgradeHeader = req.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        const url = new URL(req.url);

        if (url.pathname === '/ws/pty') {
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) {
            return new Response('sessionId query parameter required', {
              status: 400
            });
          }

          const colsParam = url.searchParams.get('cols');
          const rowsParam = url.searchParams.get('rows');

          const upgraded = server.upgrade(req, {
            data: {
              type: 'pty' as const,
              sessionId,
              connectionId: generateConnectionId(),
              cols: colsParam ? Number.parseInt(colsParam, 10) : undefined,
              rows: rowsParam ? Number.parseInt(rowsParam, 10) : undefined
            }
          });
          if (upgraded) {
            return undefined as unknown as Response;
          }
          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        if (url.pathname === '/ws' || url.pathname === '/api/ws') {
          const upgraded = server.upgrade(req, {
            data: {
              type: 'control' as const,
              connectionId: generateConnectionId()
            }
          });
          if (upgraded) {
            return undefined as unknown as Response;
          }
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
      }

      // Regular HTTP request
      return router.route(req);
    },
    container,
    wsAdapter
  };
}

/**
 * Start the HTTP API server on port 3000.
 * Returns server info and a cleanup function for graceful shutdown.
 */
export async function startServer(): Promise<ServerInstance> {
  const app = await createApplication();

  serve<WSData>({
    idleTimeout: 255,
    fetch: (req, server) => app.fetch(req, server),
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
          } else {
            app.wsAdapter.onOpen(ws);
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
          } else {
            app.wsAdapter.onClose(ws, code, reason);
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
          } else {
            await app.wsAdapter.onMessage(ws, message);
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
    // Cleanup handles application-level resources (processes, ports).
    // WebSocket connections are closed automatically when the process exits -
    // Bun's serve() handles transport cleanup on shutdown.
    cleanup: async () => {
      if (!app.container.isInitialized()) return;

      try {
        const processService = app.container.get('processService');
        const portService = app.container.get('portService');
        const watchService = app.container.get('watchService');

        const stoppedWatches = await watchService.stopAllWatches();
        if (stoppedWatches > 0) {
          logger.info('Stopped file watches during shutdown', {
            count: stoppedWatches
          });
        }

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

/**
 * Register graceful shutdown handlers for SIGTERM and SIGINT.
 * Safe to call multiple times - handlers are only registered once.
 */
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
