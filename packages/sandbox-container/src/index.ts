import { createLogger } from '@repo/shared';
import { serve } from "bun";
import { Container } from './core/container';
import { Router } from './core/router';
import { setupRoutes } from './routes/setup';

// Create module-level logger for server lifecycle events
const logger = createLogger({ component: 'container' });

async function createApplication(): Promise<{ fetch: (req: Request) => Promise<Response> }> {
  // Initialize dependency injection container
  const container = new Container();
  await container.initialize();

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

// Initialize the application
const app = await createApplication();

// Start the Bun server
const server = serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: 3000,
  // Enhanced WebSocket placeholder for future streaming features
  websocket: { 
    async message() { 
      // WebSocket functionality can be added here in the future
    } 
  },
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
      logger.error('Error during cleanup', error instanceof Error ? error : new Error(String(error)));
    }
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.emit('SIGTERM');
});
