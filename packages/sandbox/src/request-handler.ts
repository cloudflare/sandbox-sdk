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

/**
 * Options that tune the per-isolate token validation cache.
 *
 * The cache turns preview URL traffic from one DO RPC per request into one
 * RPC per {sandboxId, port, token} triple per TTL window. It is intentionally
 * a bridge toward signed (HMAC) tokens that can be verified locally with
 * zero RPCs; until that lands, caching is the cheapest way to keep DO load
 * proportional to unique previews rather than unique requests.
 */
export interface TokenValidationCacheOptions {
  /**
   * How long a successful validation is trusted before re-checking with the
   * Durable Object. This directly bounds how long a token revoked via
   * `unexposePort()` can continue to authorize traffic in other isolates.
   *
   * Defaults to 10 seconds: long enough to absorb a page-load burst (which
   * happens in sub-second), short enough that revocation feels responsive.
   * Set to 0 to disable caching entirely.
   */
  ttlMs?: number;
  /**
   * Maximum number of entries held per isolate. When exceeded, the oldest
   * entry is evicted first. Protects against adversarial traffic that rotates
   * tokens on every request. Defaults to 10,000.
   */
  maxEntries?: number;
}

const DEFAULT_TOKEN_CACHE_TTL_MS = 10_000;
const DEFAULT_TOKEN_CACHE_MAX_ENTRIES = 10_000;

/**
 * Per-isolate cache of successful token validations. Invariants:
 *
 * - Only successes are stored. A `false` result must never be cached so a
 *   transient "port not exposed" state (e.g. mid-restart) recovers on the
 *   next request rather than being pinned as invalid.
 * - TTL-bounded. Caps the revocation-propagation window.
 * - Size-bounded. Oldest entries evicted first; hits refresh insertion
 *   order so recently validated triples survive.
 * - Per-isolate. Lost on Worker eviction, which is fine — the next request
 *   simply re-validates.
 */
export class TokenValidationCache {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: TokenValidationCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TOKEN_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_TOKEN_CACHE_MAX_ENTRIES;
  }

  has(key: string): boolean {
    if (this.ttlMs <= 0) return false;
    const timestamp = this.entries.get(key);
    if (timestamp === undefined) return false;
    if (Date.now() - timestamp >= this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    // Refresh insertion order so hot entries survive size-cap eviction.
    this.entries.delete(key);
    this.entries.set(key, timestamp);
    return true;
  }

  remember(key: string): void {
    if (this.ttlMs <= 0) return;
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, Date.now());
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// Default per-isolate cache used by the simple `proxyToSandbox(request, env)`
// call path. Callers that need custom TTL or size limits can pass options.
const defaultTokenValidationCache = new TokenValidationCache();

/**
 * Clear the default token validation cache. Useful in tests and for callers
 * that need to force re-validation after an out-of-band token change.
 */
export function clearTokenValidationCache(): void {
  defaultTokenValidationCache.clear();
}

export interface ProxyToSandboxOptions {
  /**
   * Override the per-isolate token validation cache. Pass a long-lived
   * `TokenValidationCache` instance to use tuned TTL/size limits; omit to
   * share the module-level default (10 s TTL, 10,000 entries).
   */
  tokenValidationCache?: TokenValidationCache;
}

export async function proxyToSandbox<
  T extends Sandbox<any>,
  E extends SandboxEnv<T>
>(
  request: Request,
  env: E,
  options?: ProxyToSandboxOptions
): Promise<Response | null> {
  const cache = options?.tokenValidationCache ?? defaultTokenValidationCache;
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
      const cacheKey = `${sandboxId}:${port}:${token}`;

      // Fast path: recent successful validation for this exact triple.
      let isValidToken = cache.has(cacheKey);

      if (!isValidToken) {
        // Slow path: ask the Durable Object. Only successes are cached —
        // failures must re-check on every request so a transient "not
        // exposed" state does not get pinned as permanently invalid.
        isValidToken = await sandbox.validatePortToken(port, token);
        if (isValidToken) {
          cache.remember(cacheKey);
        }
      }

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

    const headers: Record<string, string> = {
      'X-Original-URL': request.url,
      'X-Forwarded-Host': url.hostname,
      'X-Forwarded-Proto': url.protocol.replace(':', ''),
      'X-Sandbox-Name': sandboxId
    };
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const proxyRequest = new Request(proxyUrl, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error - duplex required for body streaming in modern runtimes
      duplex: 'half',
      redirect: 'manual' // Do not follow redirects, return them to the client to handle
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

  // No hyphens in tokens: URL is {port}-{sandboxId}-{token}.{domain}
  // We split at the LAST hyphen, so hyphens in tokens would be ambiguous
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
