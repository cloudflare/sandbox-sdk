import { switchPort } from '@cloudflare/containers';
import { createLogger, type LogContext, TraceContext } from '@repo/shared';
import { getSandbox, type Sandbox } from './sandbox';
import { sanitizeSandboxId, validatePort } from './security';

export interface SandboxEnv<T extends Sandbox<any> = Sandbox<any>> {
  Sandbox: DurableObjectNamespace<T>;
}

export interface RouteInfo {
  port: number;
  sandboxId: string;
  path: string;
  token: string;
}

export async function proxyToSandbox<
  T extends Sandbox<any>,
  E extends SandboxEnv<T>
>(request: Request, env: E): Promise<Response | null> {
  // Create logger context for this request
  const traceId =
    TraceContext.fromHeaders(request.headers) || TraceContext.generate();
  const logger = createLogger({
    component: 'sandbox-do',
    traceId,
    operation: 'proxy'
  });

  try {
    const url = new URL(request.url);
    const routeInfo = extractSandboxRoute(url);

    if (!routeInfo) {
      return null; // Not a request to an exposed container port
    }

    const { sandboxId, port, path, token } = routeInfo;
    // Preview URLs always use normalized (lowercase) IDs
    const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

    // Critical security check: Validate token (mandatory for all user ports)
    // Skip check for control plane port 3000
    if (port !== 3000) {
      // Validate the token matches the port
      const isValidToken = await sandbox.validatePortToken(port, token);
      if (!isValidToken) {
        logger.warn('Invalid token access blocked', {
          port,
          sandboxId,
          path,
          hostname: url.hostname,
          url: request.url,
          method: request.method,
          userAgent: request.headers.get('User-Agent') || 'unknown'
        });

        return new Response(
          JSON.stringify({
            error: `Access denied: Invalid token or port not exposed`,
            code: 'INVALID_TOKEN'
          }),
          {
            status: 404,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
      }
    }

    // Detect WebSocket upgrade request
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      // WebSocket path: Must use fetch() not containerFetch()
      // This bypasses JSRPC serialization boundary which cannot handle WebSocket upgrades
      return await sandbox.fetch(switchPort(request, port));
    }

    // Build proxy request with proper headers
    let proxyUrl: string;

    // Route based on the target port
    if (port !== 3000) {
      // Route directly to user's service on the specified port
      proxyUrl = `http://localhost:${port}${path}${url.search}`;
    } else {
      // Port 3000 is our control plane - route normally
      proxyUrl = `http://localhost:3000${path}${url.search}`;
    }

    const proxyRequest = new Request(proxyUrl, {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers),
        'X-Original-URL': request.url,
        'X-Forwarded-Host': url.hostname,
        'X-Forwarded-Proto': url.protocol.replace(':', ''),
        'X-Sandbox-Name': sandboxId // Pass the friendly name
      },
      body: request.body,
      // @ts-expect-error - duplex required for body streaming in modern runtimes
      duplex: 'half'
    });

    return await sandbox.containerFetch(proxyRequest, port);
  } catch (error) {
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
  const domain = url.hostname.slice(dotIndex + 1);

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

  // Validate token format (no hyphens allowed)
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
    path: url.pathname || '/',
    token
  };
}

export function isLocalhostPattern(hostname: string): boolean {
  // Handle IPv6 addresses in brackets (with or without port)
  if (hostname.startsWith('[')) {
    if (hostname.includes(']:')) {
      // [::1]:port format
      const ipv6Part = hostname.substring(0, hostname.indexOf(']:') + 1);
      return ipv6Part === '[::1]';
    } else {
      // [::1] format without port
      return hostname === '[::1]';
    }
  }

  // Handle bare IPv6 without brackets
  if (hostname === '::1') {
    return true;
  }

  // For IPv4 and regular hostnames, split on colon to remove port
  const hostPart = hostname.split(':')[0];

  return (
    hostPart === 'localhost' ||
    hostPart === '127.0.0.1' ||
    hostPart === '0.0.0.0'
  );
}
