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
    const proxyUrl = `http://localhost:3000/proxy/${port}${path}${url.search}`;
    const proxyRequest = new Request(proxyUrl, {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers),
        'X-Original-URL': request.url,
        'X-Forwarded-Host': url.hostname,
        'X-Forwarded-Proto': url.protocol.replace(':', ''),
      },
      body: request.body,
    });

    return sandbox.containerFetch(proxyRequest);
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
    const pathMatch = url.pathname.match(/^\/preview\/(\d+)\/([^\/]+)(\/.*)?$/);
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

// Convenience wrapper for simple use cases
export function createSandboxWorker<E extends SandboxEnv>(
  routeHandler?: (request: Request, env: E) => Promise<Response> | Response
) {
  return {
    async fetch(request: Request, env: E): Promise<Response> {
      const sandboxResponse = await handleSandboxRequest(request, env);
      if (sandboxResponse) return sandboxResponse;

      if (routeHandler) {
        return routeHandler(request, env);
      }

      return new Response("Not found", { status: 404 });
    }
  };
}
