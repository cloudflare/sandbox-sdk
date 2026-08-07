/**
 * Custom span instrumentation for the bridge API.
 *
 * Wraps each Hono route handler in a Cloudflare custom span
 * (`tracing.enterSpan`) named `bridge.<operation>`, seeding common attributes
 * (sandbox ID, container UUID, HTTP method/route, response status) and exposing
 * the active span so handlers can attach operation-specific metadata.
 *
 * See https://developers.cloudflare.com/workers/observability/traces/custom-spans/
 */

import { tracing } from 'cloudflare:workers';
import type { Context } from 'hono';
import type { BridgeEnv } from './types';

/**
 * Span shape exposed to handlers. Mirrors the `cloudflare:workers` Span without
 * importing the class value, so the type is usable wherever the import isn't.
 */
export interface BridgeSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: boolean | number | string): void;
}

/** Hono environment shared by all bridge routes. */
export interface BridgeHonoEnv {
  Bindings: BridgeEnv;
  Variables: { containerUUID: string; span?: BridgeSpan };
}

type BridgeContext = Context<BridgeHonoEnv>;
type BridgeHandler = (c: BridgeContext) => Response | Promise<Response>;

/** True when the runtime exposes the custom-span API. */
function tracingAvailable(): boolean {
  return (
    typeof tracing === 'object' &&
    tracing !== null &&
    typeof tracing.enterSpan === 'function'
  );
}

/**
 * Wrap a route handler in a `bridge.<name>` span. Seeds common attributes and
 * stashes the span on the context for `annotate()`. When tracing is
 * unavailable the handler runs unchanged.
 */
export function traced(name: string, handler: BridgeHandler): BridgeHandler {
  if (!tracingAvailable()) return handler;

  return (c: BridgeContext) =>
    tracing.enterSpan(`bridge.${name}`, async (span) => {
      span.setAttribute('bridge.operation', name);
      span.setAttribute('http.request.method', c.req.method);
      span.setAttribute('http.route', c.req.routePath);

      const sandboxId = c.req.param('id');
      if (sandboxId) span.setAttribute('sandbox.id', sandboxId);

      const containerUUID = c.get('containerUUID');
      if (containerUUID) {
        span.setAttribute('sandbox.container_uuid', containerUUID);
      }

      c.set('span', span);

      const response = await handler(c);
      span.setAttribute('http.response.status_code', response.status);
      return response;
    });
}

/**
 * Attach an attribute to the active bridge span, if any. No-op when tracing is
 * disabled or the request is not sampled.
 */
export function annotate(
  c: BridgeContext,
  key: string,
  value?: boolean | number | string
): void {
  c.get('span')?.setAttribute(key, value);
}
