import type { OpenCodeHandle } from './lifecycle';

/** Configuration for {@link createOpenCodeProxy}. */
export interface OpenCodeProxyOptions {
  /** Origin the OpenCode web UI should call back through. Defaults to the request origin. */
  callbackOrigin?: string;
}

/**
 * Proxy a request to the OpenCode web UI through a lifecycle handle.
 *
 * For an initial HTML page load that still lacks the `?url=` parameter, returns
 * a redirect that adds it (so the OpenCode frontend calls back through the
 * proxy instead of `127.0.0.1:4096`). Every other request is routed through
 * `handle.fetch`, which ensures the server is running before forwarding into the
 * container.
 */
export function proxyToOpenCodeUI(
  request: Request,
  handle: OpenCodeHandle,
  options?: OpenCodeProxyOptions
): Response | Promise<Response> {
  const url = new URL(request.url);

  // OpenCode's frontend defaults its API base to 127.0.0.1:4096; the ?url=
  // parameter overrides that. Only redirect initial HTML GET loads — redirecting
  // a POST would drop the body.
  if (!url.searchParams.has('url') && request.method === 'GET') {
    const accept = request.headers.get('accept') || '';
    const isHtmlRequest = accept.includes('text/html') || url.pathname === '/';
    if (isHtmlRequest) {
      url.searchParams.set('url', options?.callbackOrigin ?? url.origin);
      return Response.redirect(url.toString(), 302);
    }
  }

  // Ensure-then-forward: the handle starts the server on demand before proxying.
  return handle.fetch(request);
}

/**
 * Curried Worker fetch wrapper for OpenCode.
 *
 * `createOpenCodeProxy(resolve, options?)` captures a lazy per-request resolver
 * for the OpenCode lifecycle handle (`sandbox.opencode`) and returns a function
 * that wraps the user's worker entrypoint.
 *
 * The wrapped handler runs first. If it returns a 404 (or has no `fetch`), the
 * request falls through to the OpenCode web-UI proxy — the redirect handshake
 * for HTML loads and an ensure-then-forward into the container for everything
 * else. A 404 from the user handler is the "not mine, proxy it" signal, so the
 * handler only needs to own its own routes and `return new Response('Not
 * found', { status: 404 })` for the rest.
 *
 * ```ts
 * export default createOpenCodeProxy(
 *   (env) => getSandbox(env.Sandbox, 'my-sandbox').opencode
 * )({
 *   async fetch(request, env) {
 *     // handle your own routes, else:
 *     return new Response('Not found', { status: 404 });
 *   }
 * });
 * ```
 */
export function createOpenCodeProxy<Env>(
  resolve: (env: Env) => OpenCodeHandle,
  options?: OpenCodeProxyOptions
): (handler: ExportedHandler<Env>) => ExportedHandler<Env> {
  return (handler) => ({
    async fetch(request, env, ctx) {
      if (handler.fetch) {
        const response = await handler.fetch(request, env, ctx);
        if (response.status !== 404) return response;
      }
      return proxyToOpenCodeUI(request, resolve(env), options);
    }
  });
}
