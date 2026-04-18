/**
 * cloudflare-sandbox-bridge — Cloudflare Sandbox Worker
 *
 * This is a thin wrapper around the bridge from @cloudflare/sandbox/bridge.
 * All API routes, pool management, and authentication are handled by the bridge.
 *
 * To upgrade: bump the @cloudflare/sandbox version in package.json.
 */

import { bridge } from '@cloudflare/sandbox/bridge';

// Re-export Sandbox so Wrangler can wire up the Durable Object binding.
export { Sandbox } from '@cloudflare/sandbox';

// Re-export WarmPool so Wrangler can wire up its Durable Object binding.
export { WarmPool } from '@cloudflare/sandbox/bridge';

export default bridge({
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Application-specific fetch handling (runs after bridge routes).
    // Return custom responses here, or remove this handler to let the
    // bridge return 404 for non-API routes.
    return new Response('OK');
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Application-specific scheduled logic (runs after pool priming).
  }
});
