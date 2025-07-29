// Refactored Index.ts - New Modular Architecture
import { serve } from "bun";
import { DIContainer } from './core/container';
import { Router } from './core/router';
import { setupRoutes } from './routes/setup';

async function createApplication(): Promise<{ fetch: (req: Request) => Promise<Response> }> {
  // Initialize dependency injection container
  const container = new DIContainer();
  await container.initialize();
  
  // Create and configure router
  const router = new Router();
  
  // Add global CORS middleware
  router.use(container.get('corsMiddleware'));
  
  // Setup all application routes
  setupRoutes(router, container);
  
  console.log('✅ Application initialized with modular architecture');
  console.log('📦 Services loaded: Session, Process, File, Port, Git');
  console.log('🔒 Security services: Validation, Path security, Command filtering');
  console.log('🚀 Handlers: Execute, File operations, Process management, Port management, Git');
  console.log('⚙️  Middleware: CORS, Validation, Logging');

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

console.log(`🚀 New Modular Bun Server running on http://0.0.0.0:${server.port}`);
console.log('');
console.log('📡 Enhanced HTTP API endpoints:');
console.log('');
console.log('🔐 Session Management:');
console.log('   POST /api/session/create     - Create a new session');
console.log('   GET  /api/session/list       - List all sessions');
console.log('');
console.log('⚡ Command Execution:');
console.log('   POST /api/execute            - Execute a command (non-streaming)');
console.log('   POST /api/execute/stream     - Execute a command (streaming SSE)');
console.log('');
console.log('📂 File Operations:');
console.log('   POST /api/read               - Read a file');
console.log('   POST /api/write              - Write a file');
console.log('   POST /api/delete             - Delete a file');
console.log('   POST /api/rename             - Rename a file');
console.log('   POST /api/move               - Move a file');
console.log('   POST /api/mkdir              - Create a directory');
console.log('');
console.log('🔗 Port Management:');
console.log('   POST   /api/expose-port      - Expose a port for external access');
console.log('   GET    /api/exposed-ports    - List exposed ports');
console.log('   DELETE /api/exposed-ports/{port} - Unexpose a specific port');
console.log('   *      /proxy/{port}/*       - Proxy requests to exposed ports');
console.log('');
console.log('🔄 Process Management:');
console.log('   POST   /api/process/start    - Start a background process');
console.log('   GET    /api/process/list     - List all processes');
console.log('   GET    /api/process/{id}     - Get process status');
console.log('   DELETE /api/process/{id}     - Kill a process');
console.log('   GET    /api/process/{id}/logs - Get process logs');
console.log('   GET    /api/process/{id}/stream - Stream process logs (SSE)');
console.log('   DELETE /api/process/kill-all - Kill all processes');
console.log('');
console.log('📚 Git Operations:');
console.log('   POST /api/git/checkout       - Clone/checkout a git repository');
console.log('');
console.log('🔧 Utilities:');
console.log('   GET  /api/ping               - Health check');
console.log('   GET  /api/commands           - List available commands');
console.log('   GET  /                       - Root endpoint');
console.log('');
console.log('🎯 Architecture Improvements:');
console.log('   ✅ Modular service architecture');
console.log('   ✅ Dependency injection pattern');
console.log('   ✅ Centralized security validation');
console.log('   ✅ Structured error handling');
console.log('   ✅ Comprehensive logging');
console.log('   ✅ Type safety throughout');
console.log('   ✅ Bun-optimized performance');
console.log('   ✅ Clean separation of concerns');
console.log('');

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully...');
  
  // Get services for cleanup
  const container = new DIContainer();
  if (container.isInitialized()) {
    try {
      // Cleanup services
      const sessionService = container.get('sessionService');
      const processService = container.get('processService');
      const portService = container.get('portService');
      
      // Cleanup sessions
      if ('destroy' in sessionService) {
        (sessionService as any).destroy();
      }
      
      // Cleanup processes
      if ('destroy' in processService) {
        await (processService as any).destroy();
      }
      
      // Cleanup ports
      if ('destroy' in portService) {
        (portService as any).destroy();
      }
      
      console.log('✅ Services cleaned up successfully');
    } catch (error) {
      console.error('❌ Error during cleanup:', error);
    }
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🔄 Received SIGINT, shutting down gracefully...');
  process.emit('SIGTERM');
});