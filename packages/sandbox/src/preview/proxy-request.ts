import { PREVIEW_PROXY_HEADERS } from './protocol';

export interface BuildPreviewProxyRequestOptions {
  port: number;
  sandboxId: string;
  sandboxName: string | null;
}

export function buildPreviewProxyRequest(
  request: Request,
  { port, sandboxId, sandboxName }: BuildPreviewProxyRequestOptions
): Request {
  const url = new URL(request.url);
  const proxyURL = `http://localhost:${port}${url.pathname}${url.search}`;
  const headers = stripPreviewProxyHeaders(request.headers);

  headers.set('X-Original-URL', request.url);
  headers.set('X-Forwarded-Host', url.hostname);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
  headers.set('X-Sandbox-Name', sandboxName ?? sandboxId);

  // WebSocket upgrades take the same localhost URL as other requests, so the
  // app sees one Host. The Upgrade header carries the upgrade semantics.
  return new Request(proxyURL, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex required for body streaming in modern runtimes
    duplex: 'half',
    redirect: 'manual'
  });
}

function stripPreviewProxyHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const header of PREVIEW_PROXY_HEADERS) {
    headers.delete(header);
  }
  headers.delete('cf-container-target-port');
  headers.delete('x-sandbox-port-route-token');
  return headers;
}
