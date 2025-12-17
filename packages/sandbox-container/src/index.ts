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

// Create module-level logger for server lifecycle events
const logger = createLogger({ component: 'container' });

async function createApplication(): Promise<{
  fetch: (
    req: Request,
    server: ReturnType<typeof serve<WSData>>
  ) => Promise<Response>;
  router: Router;
  wsHandler: WebSocketHandler;
}> {
  // Initialize dependency injection container
  const container = new Container();
  await container.initialize();

  // Create and configure router
  const router = new Router(logger);

  // Add global CORS middleware
  router.use(container.get('corsMiddleware'));

  // Setup all application routes
  setupRoutes(router, container);

  // Create WebSocket handler with the router
  const wsHandler = new WebSocketHandler(router, logger);

  return {
    fetch: async (req: Request, server: ReturnType<typeof serve<WSData>>) => {
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
    router,
    wsHandler
  };
}

// Initialize the application
const app = await createApplication();

// Start the Bun server
const server = serve<WSData>({
  idleTimeout: 255,
  fetch: (req, server) => app.fetch(req, server),
  hostname: '0.0.0.0',
  port: 3000,
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
  port: server.port,
  hostname: '0.0.0.0'
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');

  // Get services for cleanup
  const container = new Container();
  if (container.isInitialized()) {
    try {
      // Cleanup services with proper typing
      const processService = container.get('processService');
      const portService = container.get('portService');

      // Cleanup processes (asynchronous - kills all running processes)
      await processService.destroy();

      // Cleanup ports (synchronous)
      portService.destroy();

      logger.info('Services cleaned up successfully');
    } catch (error) {
      logger.error(
        'Error during cleanup',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.emit('SIGTERM');
});
