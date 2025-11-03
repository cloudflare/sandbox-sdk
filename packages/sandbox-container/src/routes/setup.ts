// Route Setup

import type { Container } from '../core/container';
import type { Router } from '../core/router';

export function setupRoutes(router: Router, container: Container): void {
  // Session routes
  router.register({
    method: 'POST',
    path: '/api/session/create',
    handler: async (req, ctx) =>
      container.get('sessionHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/session/list',
    handler: async (req, ctx) =>
      container.get('sessionHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/session/delete',
    handler: async (req, ctx) =>
      container.get('sessionHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // Execute routes
  router.register({
    method: 'POST',
    path: '/api/execute',
    handler: async (req, ctx) =>
      container.get('executeHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/execute/stream',
    handler: async (req, ctx) =>
      container.get('executeHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // File operation routes
  router.register({
    method: 'POST',
    path: '/api/read',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/read/stream',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/write',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/delete',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/rename',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/move',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/mkdir',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/list-files',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/exists',
    handler: async (req, ctx) => container.get('fileHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // Port management routes
  router.register({
    method: 'POST',
    path: '/api/expose-port',
    handler: async (req, ctx) => container.get('portHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/exposed-ports',
    handler: async (req, ctx) => container.get('portHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'DELETE',
    path: '/api/exposed-ports/{port}',
    handler: async (req, ctx) => container.get('portHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // Process management routes
  router.register({
    method: 'POST',
    path: '/api/process/start',
    handler: async (req, ctx) =>
      container.get('processHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/process/list',
    handler: async (req, ctx) =>
      container.get('processHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'DELETE',
    path: '/api/process/kill-all',
    handler: async (req, ctx) =>
      container.get('processHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/process/{id}',
    handler: async (req, ctx) =>
      container.get('processHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'DELETE',
    path: '/api/process/{id}',
    handler: async (req, ctx) =>
      container.get('processHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/process/{id}/logs',
    handler: async (req, ctx) =>
      container.get('processHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/process/{id}/stream',
    handler: async (req, ctx) =>
      container.get('processHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // Git operations
  router.register({
    method: 'POST',
    path: '/api/git/checkout',
    handler: async (req, ctx) => container.get('gitHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // Interpreter/Code execution routes
  router.register({
    method: 'GET',
    path: '/api/interpreter/health',
    handler: async (req, ctx) =>
      container.get('interpreterHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/contexts',
    handler: async (req, ctx) =>
      container.get('interpreterHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/contexts',
    handler: async (req, ctx) =>
      container.get('interpreterHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'DELETE',
    path: '/api/contexts/{id}',
    handler: async (req, ctx) =>
      container.get('interpreterHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/api/execute/code',
    handler: async (req, ctx) =>
      container.get('interpreterHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // Proxy routes (catch-all for /proxy/*)
  router.register({
    method: 'GET',
    path: '/proxy/{port}',
    handler: async (req, ctx) => container.get('portHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'POST',
    path: '/proxy/{port}',
    handler: async (req, ctx) => container.get('portHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'PUT',
    path: '/proxy/{port}',
    handler: async (req, ctx) => container.get('portHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'DELETE',
    path: '/proxy/{port}',
    handler: async (req, ctx) => container.get('portHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  // Miscellaneous routes
  router.register({
    method: 'GET',
    path: '/',
    handler: async (req, ctx) => container.get('miscHandler').handle(req, ctx)
  });

  router.register({
    method: 'GET',
    path: '/api/ping',
    handler: async (req, ctx) => container.get('miscHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/commands',
    handler: async (req, ctx) => container.get('miscHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });

  router.register({
    method: 'GET',
    path: '/api/version',
    handler: async (req, ctx) => container.get('miscHandler').handle(req, ctx),
    middleware: [container.get('loggingMiddleware')]
  });
}
