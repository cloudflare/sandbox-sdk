// Modular Container Server
import { serve } from "bun";
import { Container } from './core/container';
import { Router } from './core/router';
import { setupRoutes } from './routes/setup';

async function createApplication(): Promise<{ fetch: (req: Request) => Promise<Response> }> {
  // Initialize dependency injection container
  const container = new Container();
  await container.initialize();
  
  // Create and configure router
  const router = new Router();
  
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

// Start the Bun server with enhanced configuration
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

console.log(`Bun Server running on http://0.0.0.0:${server.port}`);

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  
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

      console.log('Services cleaned up successfully');
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.emit('SIGTERM');
});
