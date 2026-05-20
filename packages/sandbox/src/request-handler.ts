import { createLogger, TraceContext } from '@repo/shared';
import {
  PREVIEW_PROXY_HEADER,
  PREVIEW_PROXY_HEADERS,
  PREVIEW_PROXY_PORT_HEADER,
  PREVIEW_PROXY_SANDBOX_ID_HEADER,
  PREVIEW_PROXY_TOKEN_HEADER
} from './preview-proxy-protocol';
import { getSandbox, type Sandbox } from './sandbox';
import { sanitizeSandboxId, validatePort } from './security';

export interface SandboxEnv<T extends Sandbox<any> = Sandbox<any>> {
  Sandbox: DurableObjectNamespace<T>;
}

interface RouteInfo {
  port: number;
  sandboxId: string;
  token: string;
}

function createProxyLogger(request: Request) {
  const traceId =
    TraceContext.fromHeaders(request.headers) || TraceContext.generate();
  return createLogger({
    component: 'sandbox-do',
    traceId,
    operation: 'proxy'
  });
}

export async function proxyToSandbox<
  T extends Sandbox<any>,
  E extends SandboxEnv<T>
>(request: Request, env: E): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const routeInfo = extractSandboxRoute(url);

    if (!routeInfo) {
      return null; // Not a request to an exposed container port
    }

    const { sandboxId, port, token } = routeInfo;
    // Preview URLs always use normalized (lowercase) IDs
    const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

    const headers = new Headers(request.headers);
    for (const header of PREVIEW_PROXY_HEADERS) {
      headers.delete(header);
    }
    headers.set(PREVIEW_PROXY_HEADER, '1');
    headers.set(PREVIEW_PROXY_PORT_HEADER, port.toString());
    headers.set(PREVIEW_PROXY_TOKEN_HEADER, token);
    headers.set(PREVIEW_PROXY_SANDBOX_ID_HEADER, sandboxId);

    const previewRequest = new Request(request, { headers });
    return await sandbox.fetch(previewRequest);
  } catch (error) {
    const logger = createProxyLogger(request);
    logger.error(
      'Proxy routing error',
      error instanceof Error ? error : new Error(String(error))
    );
    return new Response('Proxy routing error', { status: 500 });
  }
}

function extractSandboxRoute(url: URL): RouteInfo | null {
  // URL format: {port}-{sandboxId}-{token}.{domain}
  // Tokens are [a-z0-9_]+, so we split at the last hyphen to handle sandboxIds with hyphens (UUIDs)
  const dotIndex = url.hostname.indexOf('.');
  if (dotIndex === -1) {
    return null;
  }

  const subdomain = url.hostname.slice(0, dotIndex);

  // Extract port (digits at start followed by hyphen)
  const firstHyphen = subdomain.indexOf('-');
  if (firstHyphen === -1) {
    return null;
  }

  const portStr = subdomain.slice(0, firstHyphen);
  if (!/^\d{4,5}$/.test(portStr)) {
    return null;
  }

  const port = parseInt(portStr, 10);
  if (!validatePort(port)) {
    return null;
  }

  // Extract token (last hyphen-delimited segment) and sandboxId (everything between port and token)
  const rest = subdomain.slice(firstHyphen + 1);
  const lastHyphen = rest.lastIndexOf('-');
  if (lastHyphen === -1) {
    return null;
  }

  const sandboxId = rest.slice(0, lastHyphen);
  const token = rest.slice(lastHyphen + 1);

  // No hyphens in tokens: URL is {port}-{sandboxId}-{token}.{domain}
  // We split at the LAST hyphen, so hyphens in tokens would be ambiguous.
  // The SDK issues tokens up to 16 chars; 63 is the DNS label component limit.
  if (!/^[a-z0-9_]+$/.test(token) || token.length === 0 || token.length > 63) {
    return null;
  }

  // Validate and sanitize sandboxId
  if (sandboxId.length === 0 || sandboxId.length > 63) {
    return null;
  }

  let sanitizedSandboxId: string;
  try {
    sanitizedSandboxId = sanitizeSandboxId(sandboxId);
  } catch {
    return null;
  }

  return {
    port,
    sandboxId: sanitizedSandboxId,
    token
  };
}
