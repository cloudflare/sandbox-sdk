import { createLogger } from '@repo/shared';
import { serve } from 'bun';
import { Container } from './core/container';
import { Router } from './core/router';
import {
  generateConnectionId,
  WebSocketHandler,
  type WSData
} from './handlers/ws-handler';
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
  wsHandler: WebSocketHandler;
}> {
  const container = new Container();
  await container.initialize();

  const router = new Router(logger);
  router.use(container.get('corsMiddleware'));
  setupRoutes(router, container);

  // Create WebSocket handler with the router for control plane multiplexing
  const wsHandler = new WebSocketHandler(router, logger);

  return {
    fetch: async (
      req: Request,
      server: ReturnType<typeof serve<WSData>>
    ): Promise<Response> => {
      // Check for WebSocket upgrade request
      const upgradeHeader = req.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        // Handle WebSocket upgrade for control plane
        const url = new URL(req.url);
        if (url.pathname === '/ws' || url.pathname === '/api/ws') {
          const upgraded = server.upgrade(req, {
            data: {
              connectionId: generateConnectionId()
            }
          });
          if (upgraded) {
            return undefined as unknown as Response; // Bun handles the upgrade
          }
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
      }

      // Regular HTTP request
      return router.route(req);
    },
    container,
    wsHandler
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
    // WebSocket handlers for control plane multiplexing
    websocket: {
      open(ws) {
        app.wsHandler.onOpen(ws);
      },
      close(ws, code, reason) {
        app.wsHandler.onClose(ws, code, reason);
      },
      async message(ws, message) {
        await app.wsHandler.onMessage(ws, message);
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
        const processService = app.container.get('processService');
        const portService = app.container.get('portService');

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
