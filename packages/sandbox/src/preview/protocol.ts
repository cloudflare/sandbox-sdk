import { validatePort } from '../security';

/** @internal */
export const PREVIEW_PROXY_HEADER = 'x-sandbox-preview-proxy';
/** @internal */
export const PREVIEW_PROXY_PORT_HEADER = 'x-sandbox-preview-port';
/** @internal */
export const PREVIEW_PROXY_TOKEN_HEADER = 'x-sandbox-preview-token';
/** @internal */
export const PREVIEW_PROXY_SANDBOX_ID_HEADER = 'x-sandbox-preview-sandbox-id';

/** @internal */
export const PREVIEW_PROXY_HEADERS = [
  PREVIEW_PROXY_HEADER,
  PREVIEW_PROXY_PORT_HEADER,
  PREVIEW_PROXY_TOKEN_HEADER,
  PREVIEW_PROXY_SANDBOX_ID_HEADER
] as const;

export interface PreviewProxyMetadata {
  port: number;
  token: string;
  sandboxId: string;
}

export function isPreviewProxyRequest(request: Request): boolean {
  return request.headers.get(PREVIEW_PROXY_HEADER) === '1';
}

export function readPreviewProxyMetadata(
  request: Request
): PreviewProxyMetadata | null {
  if (!isPreviewProxyRequest(request)) {
    return null;
  }

  const portValue = request.headers.get(PREVIEW_PROXY_PORT_HEADER);
  const token = request.headers.get(PREVIEW_PROXY_TOKEN_HEADER);
  const sandboxId = request.headers.get(PREVIEW_PROXY_SANDBOX_ID_HEADER);
  const port = portValue === null ? Number.NaN : Number.parseInt(portValue, 10);

  if (!Number.isFinite(port) || !validatePort(port) || !token || !sandboxId) {
    return null;
  }

  return { port, token, sandboxId };
}

export function withPreviewProxyMetadata(
  request: Request,
  { port, token, sandboxId }: PreviewProxyMetadata
): Request {
  const headers = new Headers(request.headers);
  for (const header of PREVIEW_PROXY_HEADERS) {
    headers.delete(header);
  }
  headers.set(PREVIEW_PROXY_HEADER, '1');
  headers.set(PREVIEW_PROXY_PORT_HEADER, port.toString());
  headers.set(PREVIEW_PROXY_TOKEN_HEADER, token);
  headers.set(PREVIEW_PROXY_SANDBOX_ID_HEADER, sandboxId);

  return new Request(request, { headers });
}
