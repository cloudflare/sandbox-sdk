import { createLogger } from '@repo/shared';
import { serve } from "bun";
import { CONFIG } from './config';
import { Container } from './core/container';
import { Router } from './core/router';
import { setupRoutes } from './routes/setup';

// Create module-level logger for server lifecycle events
const logger = createLogger({ component: 'container' });

const CONTROL_PLANE_PORT = CONFIG.CONTROL_PLANE_PORT;

logger.info('Control plane port configuration', {
  port: CONTROL_PLANE_PORT,
  source: process.env.SANDBOX_CONTROL_PLANE_PORT ? 'environment' : 'default'
});

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

// Start the Bun server with error handling for port conflicts
let server: ReturnType<typeof serve>;
try {
  server = serve({
    idleTimeout: 255,
    fetch: app.fetch,
    hostname: "0.0.0.0",
    port: CONTROL_PLANE_PORT,
    // Enhanced WebSocket placeholder for future streaming features
    websocket: { 
      async message() { 
        // WebSocket functionality can be added here in the future
      } 
    },
  });

  logger.info('Container server started successfully', {
    port: server.port,
    hostname: '0.0.0.0'
  });
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error('Failed to start container server', err, {
    port: CONTROL_PLANE_PORT,
    possibleCause: 'Port may already be in use by another process. Check if another service is using this port, or set SANDBOX_CONTROL_PLANE_PORT to a different port.'
  });
  
  if (err.message.includes('EADDRINUSE')) {
    const conflictError = new Error(`Port ${CONTROL_PLANE_PORT} is already in use. The Sandbox SDK requires this port for its control plane. Either:
1. Stop the process using port ${CONTROL_PLANE_PORT}, or
2. Set SANDBOX_CONTROL_PLANE_PORT environment variable to a different port in your Dockerfile`);
    logger.error('Port conflict detected', conflictError, {
      port: CONTROL_PLANE_PORT
    });
  }
  
  throw err;
}

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
