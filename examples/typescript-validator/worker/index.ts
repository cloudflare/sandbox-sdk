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
      // Route each browser session to its own Compiler DO. Do not use
      // sandbox sessions as a user isolation boundary.
      const workspaceId = request.headers.get('X-Workspace-ID');
      if (!workspaceId) {
        return Response.json(
          { error: 'Missing X-Workspace-ID header' },
          { status: 400 }
        );
      }

      const id = env.Compiler.idFromName(workspaceId);
      const stub = env.Compiler.get(id);
      return stub.fetch(request);
    }

    // All other requests fall through to static assets
    return new Response('Not Found', { status: 404 });
  }
} satisfies ExportedHandler<Env>;

// Export Sandbox DO from SDK
export { Sandbox } from '@cloudflare/sandbox';
// Export Compiler DO
export { CompilerDO } from './compiler';
