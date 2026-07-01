import type {
  OutboundHandler,
  OutboundHandlerContext
} from '@cloudflare/containers';
import type { ExtensionHTTPProxyParams } from './index.js';

function normalizePathPrefix(prefix: string): string {
  return prefix.startsWith('/') ? prefix : `/${prefix}`;
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  const normalized = normalizePathPrefix(prefix);
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function rewriteRedirectLocation(
  location: string | null,
  upstreamURL: URL,
  proxyOrigin: string,
  leaseId: string,
  allowedPathPrefix: string
): string | null {
  if (!location) return null;

  const redirected = new URL(location, upstreamURL);
  if (redirected.origin !== upstreamURL.origin) return null;
  if (!pathMatchesPrefix(redirected.pathname, allowedPathPrefix)) return null;

  return `${proxyOrigin}/${leaseId}${redirected.pathname}${redirected.search}`;
}

export const extensionHTTPProxyHandler: OutboundHandler<
  Cloudflare.Env,
  ExtensionHTTPProxyParams
> = async (
  request: Request,
  _env: Cloudflare.Env,
  ctx: OutboundHandlerContext<ExtensionHTTPProxyParams>
): Promise<Response> => {
  const requestURL = new URL(request.url);
  const [leaseId, ...pathSegments] = requestURL.pathname
    .split('/')
    .filter(Boolean);

  if (!leaseId || pathSegments.length === 0) {
    return new Response('Unknown extension proxy operation', { status: 404 });
  }

  const lease = ctx.params?.leases[leaseId];
  if (!lease) {
    return new Response('Unknown extension proxy operation', { status: 404 });
  }

  const proxiedPath = `/${pathSegments.join('/')}`;
  const route = lease.routes.find((candidate) => {
    const active =
      candidate.expiresAt === undefined || candidate.expiresAt > Date.now();
    return (
      active && pathMatchesPrefix(proxiedPath, candidate.allowedPathPrefix)
    );
  });

  if (!route) {
    return new Response('Extension proxy route is not allowed', {
      status: 403
    });
  }

  const upstreamOrigin = new URL(route.upstreamOrigin).origin;
  const upstreamURL = new URL(
    `${proxiedPath}${requestURL.search}`,
    upstreamOrigin
  );

  const headers = new Headers(request.headers);
  headers.delete('host');
  for (const [name, value] of Object.entries(route.injectHeaders ?? {})) {
    headers.set(name, value);
  }

  const upstreamResponse = await fetch(upstreamURL.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual'
  });

  if (!isRedirect(upstreamResponse.status)) {
    return upstreamResponse;
  }

  const rewrittenLocation = rewriteRedirectLocation(
    upstreamResponse.headers.get('location'),
    upstreamURL,
    requestURL.origin,
    leaseId,
    route.allowedPathPrefix
  );
  if (!rewrittenLocation) {
    return new Response('Extension proxy redirect is not allowed', {
      status: 502
    });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('location', rewrittenLocation);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
};
