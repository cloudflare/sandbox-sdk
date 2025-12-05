import { createLogger } from '@repo/shared';
import { serve } from 'bun';
import { Container } from './core/container';
import { Router } from './core/router';
import { setupRoutes } from './routes/setup';

// Create module-level logger for server lifecycle events
const logger = createLogger({ component: 'container' });

// Store container reference for cleanup
let containerInstance: Container | null = null;

async function createApplication(): Promise<{
  fetch: (req: Request) => Promise<Response>;
}> {
  // Initialize dependency injection container
  const container = new Container();
  await container.initialize();
  containerInstance = container;

  // Create and configure router
  const router = new Router(logger);

  // Add global CORS middleware
  router.use(container.get('corsMiddleware'));

  // Setup all application routes
  setupRoutes(router, container);

  return {
    fetch: (req: Request) => router.route(req)
  };
}

/**
 * Start the HTTP API server on port 3000.
 * Returns the Bun server instance.
 */
export async function startServer(): Promise<ReturnType<typeof serve>> {
  const app = await createApplication();

  const server = serve({
    idleTimeout: 255,
    fetch: app.fetch,
    hostname: '0.0.0.0',
    port: 3000,
    // Enhanced WebSocket placeholder for future streaming features
    websocket: {
      async message() {
        // WebSocket functionality can be added here in the future
      }
    }
  });

  logger.info('Container server started', {
    port: server.port,
    hostname: '0.0.0.0'
  });

  return server;
}

// Track whether shutdown handlers are registered
let shutdownRegistered = false;

/**
 * Register graceful shutdown handlers for SIGTERM and SIGINT.
 * Safe to call multiple times - handlers are only registered once.
 */
export function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully');

    if (containerInstance?.isInitialized()) {
      try {
        // Cleanup services with proper typing
        const processService = containerInstance.get('processService');
        const portService = containerInstance.get('portService');

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
}
