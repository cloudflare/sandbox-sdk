import { getSandbox, type Sandbox } from "./sandbox";

export interface SandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export interface RouteInfo {
  port: number;
  sandboxId: string;
  path: string;
}

export async function proxyToSandbox<E extends SandboxEnv>(
  request: Request,
  env: E
): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const routeInfo = extractSandboxRoute(url);

    if (!routeInfo) {
      return null; // Not a request to an exposed container port
    }

    const { sandboxId, port, path } = routeInfo;
    const sandbox = getSandbox(env.Sandbox, sandboxId);

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
        'X-Sandbox-Name': sandboxId, // Pass the friendly name
      },
      body: request.body,
    });

    return sandbox.containerFetch(proxyRequest, port);
  } catch (error) {
    console.error('[Sandbox] Proxy routing error:', error);
    return new Response('Proxy routing error', { status: 500 });
  }
}

function extractSandboxRoute(url: URL): RouteInfo | null {
  // Unified subdomain pattern for all environments
  // Matches: 8080-demo-user-sandbox.localhost or 8080-demo-user-sandbox.workers.dev
  const subdomainMatch = url.hostname.match(/^(\d+)-([^.]+)\.(.+)$/);
  if (subdomainMatch) {
    return {
      port: parseInt(subdomainMatch[1]),
      sandboxId: subdomainMatch[2],
      path: url.pathname || "/",
    };
  }

  return null;
}

export function isLocalhostPattern(hostname: string): boolean {
  const hostPart = hostname.split(":")[0];
  return (
    hostPart === "localhost" ||
    hostPart === "127.0.0.1" ||
    hostPart === "::1" ||
    hostPart === "[::1]" ||
    hostPart === "0.0.0.0"
  );
}

