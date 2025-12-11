import { createLogger } from '@repo/shared';
import { serve } from 'bun';
import { Container } from './core/container';
import { Router } from './core/router';
import { setupRoutes } from './routes/setup';

const logger = createLogger({ component: 'container' });
const SERVER_PORT = 3000;

export interface ServerInstance {
  port: number;
  cleanup: () => Promise<void>;
}

async function createApplication(): Promise<{
  fetch: (req: Request) => Promise<Response>;
  container: Container;
}> {
  const container = new Container();
  await container.initialize();

  const router = new Router(logger);
  router.use(container.get('corsMiddleware'));
  setupRoutes(router, container);

  return {
    fetch: (req: Request) => router.route(req),
    container
  };
}

/**
 * Start the HTTP API server on port 3000.
 * Returns server info and a cleanup function for graceful shutdown.
 */
export async function startServer(): Promise<ServerInstance> {
  const app = await createApplication();

  serve({
    idleTimeout: 255,
    fetch: app.fetch,
    hostname: '0.0.0.0',
    port: SERVER_PORT,
    websocket: {
      async message() {
        // WebSocket placeholder for future streaming features
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
