/**
 * @cloudflare/sandbox/bridge — Bridge factory for Cloudflare Sandbox Workers.
 *
 * Usage:
 * ```ts
 * import { bridge } from "@cloudflare/sandbox/bridge";
 * export { Sandbox } from "@cloudflare/sandbox";
 * export { WarmPool } from "@cloudflare/sandbox/bridge";
 *
 * export default bridge({
 *   async fetch(request, env, ctx) {
 *     return new Response("OK");
 *   },
 *   async scheduled(controller, env, ctx) {
 *     // custom scheduled logic
 *   }
 * });
 * ```
 */

import { env as cfEnv } from 'cloudflare:workers';
import { primePool } from './pool';
import { createBridgeApp, type RouteConfig } from './routes';
import type { BridgeConfig, BridgeEnv, WorkerHandlers } from './types';

// Re-export helpers that may be useful for testing / advanced use
export { resolveWorkspacePath, shellQuote } from './helpers';
export type { BridgeConfig, BridgeEnv, WorkerHandlers } from './types';
export type { PoolStats, WarmPoolConfig } from './warm-pool';
// Re-export types and utilities consumers may need
export { WarmPool } from './warm-pool';

interface CheckBindingsOptions {
  sandboxBinding: string;
  warmPoolBinding: string;
}

/**
 * Log an error if the required Durable Object bindings are missing from the
 * module-level environment. The `cloudflare:workers` env exposes binding stubs
 * at module evaluation time, so a missing key means the wrangler.jsonc
 * configuration is wrong. The health endpoint performs the same validation at
 * request time and returns a 503.
 */
function checkBindings(
  env: Record<string, unknown>,
  options: CheckBindingsOptions
): void {
  const { sandboxBinding, warmPoolBinding } = options;
  const missing: string[] = [];

  if (!env[sandboxBinding]) missing.push(sandboxBinding);
  if (!env[warmPoolBinding]) missing.push(warmPoolBinding);

  if (missing.length > 0) {
    for (const binding of missing) {
      console.error({
        message: `Missing required binding "${binding}"`,
        component: 'bridge',
        binding,
        hint: `Ensure your wrangler.jsonc has a Durable Object binding named "${binding}".`
      });
    }
  }

  if (!env.SANDBOX_API_KEY) {
    console.warn({
      message: 'SANDBOX_API_KEY is not set \u2014 auth is disabled',
      component: 'bridge',
      hint: 'Set via `wrangler secret put SANDBOX_API_KEY`.'
    });
  }
}

/**
 * Create a Worker export that wraps user handlers with bridge functionality.
 *
 * The bridge:
 * 1. Checks that required Durable Object bindings exist (logs errors if missing).
 * 2. Wraps `fetch()` to serve bridge API routes first, then falls through to the user handler.
 * 3. Wraps `scheduled()` to prime the warm pool, then calls the user handler.
 * 4. Passes through all other properties unchanged.
 *
 * @param worker - The user's worker handlers (fetch, scheduled, and any others).
 * @param config - Optional configuration for binding names and route paths.
 */
export function bridge(
  worker: WorkerHandlers,
  config?: BridgeConfig
): ExportedHandler<BridgeEnv> {
  const sandboxBinding = config?.bindings?.sandbox ?? 'Sandbox';
  const warmPoolBinding = config?.bindings?.warmPool ?? 'WarmPool';
  const apiPrefix = config?.apiRoutePrefix ?? '/v1';
  const healthPath = config?.healthRoute ?? '/health';

  // Check bindings at module evaluation time
  checkBindings(cfEnv as unknown as Record<string, unknown>, {
    sandboxBinding,
    warmPoolBinding
  });

  // Build the Hono app with the configured routes
  const routeConfig: RouteConfig = {
    sandboxBinding,
    warmPoolBinding,
    apiPrefix,
    healthPath
  };
  const app = createBridgeApp(routeConfig);

  // Collect pass-through properties from the worker (everything except fetch/scheduled)
  const passThrough: Record<string, unknown> = {};
  for (const key of Object.keys(worker)) {
    if (key !== 'fetch' && key !== 'scheduled') {
      passThrough[key] = worker[key];
    }
  }

  return {
    ...passThrough,

    async fetch(
      request: Request,
      env: BridgeEnv,
      ctx: ExecutionContext
    ): Promise<Response> {
      // 1. Try bridge API routes
      const url = new URL(request.url);
      if (
        url.pathname.startsWith(`${apiPrefix}/`) ||
        url.pathname === apiPrefix ||
        url.pathname === healthPath
      ) {
        return app.fetch(request, env, ctx);
      }

      // 2. Fall through to user handler
      if (worker.fetch) {
        return worker.fetch(request, env, ctx);
      }

      return new Response('Not Found', { status: 404 });
    },

    async scheduled(
      controller: ScheduledController,
      env: BridgeEnv,
      ctx: ExecutionContext
    ): Promise<void> {
      // Prime the warm pool on every scheduled trigger
      await primePool(env, warmPoolBinding);

      // Then call user's scheduled handler if provided
      if (worker.scheduled) {
        await worker.scheduled(controller, env, ctx);
      }
    }
  };
}
