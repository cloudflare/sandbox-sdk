import { getSandbox, type Sandbox } from "./sandbox";

export interface SandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export interface RouteInfo {
  port: number;
  sandboxId: string;
  path: string;
}

export async function handleSandboxRequest<E extends SandboxEnv>(
  request: Request,
  env: E
): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const routeInfo = extractSandboxRoute(url);

    if (!routeInfo) {
      return null; // Not a sandbox preview request
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
    console.error('[Sandbox] Preview URL routing error:', error);
    return new Response('Preview URL routing error', { status: 500 });
  }
}

function extractSandboxRoute(url: URL): RouteInfo | null {
  // Production: subdomain pattern {port}-{sandboxId}.{domain}
  const subdomainMatch = url.hostname.match(/^(\d+)-([a-zA-Z0-9-]+)\./);
  if (subdomainMatch) {
    return {
      port: parseInt(subdomainMatch[1]),
      sandboxId: subdomainMatch[2],
      path: url.pathname,
    };
  }

  // Development: path pattern /preview/{port}/{sandboxId}/*
  if (isLocalhostPattern(url.hostname)) {
    const pathMatch = url.pathname.match(/^\/preview\/(\d+)\/([^/]+)(\/.*)?$/);
    if (pathMatch) {
      return {
        port: parseInt(pathMatch[1]),
        sandboxId: pathMatch[2],
        path: pathMatch[3] || "/",
      };
    }
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

