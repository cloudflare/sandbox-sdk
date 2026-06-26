import type { Sandbox } from '../sandbox';
import { proxyToOpencode } from './opencode';

const DEFAULT_PORT = 4096;

/** Configuration for {@link createOpenCodeProxy}. */
export interface OpenCodeProxyOptions {
  /**
   * Path prefix the proxy owns. When set, any request under this prefix is
   * handled (web-UI redirect for HTML loads, otherwise proxied to the
   * container); everything else forwards to the wrapped handler. When unset,
   * the proxy owns only the OpenCode web-UI `?url=` handshake.
   */
  route?: string;
  /** Port the OpenCode server listens on (default 4096). */
  port?: number;
}

/** Decide whether a request falls within the proxy's owned surface. */
function inScope(
  url: URL,
  request: Request,
  route: string | undefined
): boolean {
  if (route) {
    return url.pathname === route || url.pathname.startsWith(`${route}/`);
  }
  // Default scope: the web-UI handshake only (HTML GET still needing ?url=).
  if (request.method !== 'GET') return false;
  if (url.searchParams.has('url')) return false;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html') || url.pathname === '/';
}

/**
 * Handle an OpenCode request, or return `null` to signal "not mine — forward".
 *
 * Reuses the terminal {@link proxyToOpencode} primitive for the `?url=`
 * redirect handshake and container forwarding.
 */
export function tryProxyOpenCode(
  request: Request,
  sandbox: Sandbox<unknown>,
  options?: OpenCodeProxyOptions
): Response | Promise<Response> | null {
  const url = new URL(request.url);
  if (!inScope(url, request, options?.route)) return null;
  const port = options?.port ?? DEFAULT_PORT;
  return proxyToOpencode(request, sandbox, {
    port,
    url: `http://localhost:${port}`,
    close: async () => {}
  });
}

/**
 * Curried Worker fetch wrapper for OpenCode.
 *
 * `createOpenCodeProxy(resolve, options?)` captures a lazy per-request sandbox
 * resolver and returns a function that wraps the user's worker entrypoint. At
 * request time it handles the OpenCode web-UI route (the `?url=` handshake plus
 * an optional `route` prefix) or forwards to the wrapped handler.
 *
 * ```ts
 * export default createOpenCodeProxy(
 *   (env) => getSandbox(env.Sandbox, 'my-sandbox')
 * )({
 *   fetch(request, env) { return new Response('hello'); }
 * });
 * ```
 */
export function createOpenCodeProxy<Env>(
  resolve: (env: Env) => Sandbox<unknown>,
  options?: OpenCodeProxyOptions
): (handler: ExportedHandler<Env>) => ExportedHandler<Env> {
  return (handler) => ({
    async fetch(request, env, ctx) {
      const sandbox = resolve(env);
      const handled = await tryProxyOpenCode(request, sandbox, options);
      if (handled) return handled;
      if (!handler.fetch) {
        return new Response('Not found', { status: 404 });
      }
      return handler.fetch(request, env, ctx);
    }
  });
}
