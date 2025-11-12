/**
 * Main entry point worker
 * Routes API requests to Compiler DO
 * Static assets (React app) handled by Vite
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route API requests to Compiler DO
    if (url.pathname === '/validate') {
      const id = env.Compiler.idFromName('singleton');
      const stub = env.Compiler.get(id);
      return stub.fetch(request);
    }

    // All other requests fall through to static assets
    return new Response('Not Found', { status: 404 });
  }
} satisfies ExportedHandler<Env>;

// Export Compiler DO
export { CompilerDO } from './compiler';

// Export Sandbox DO from SDK
export { Sandbox } from '@cloudflare/sandbox';
