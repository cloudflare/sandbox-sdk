import { getSandbox, type Sandbox } from "./sandbox";
import { logSecurityEvent, sanitizeSandboxId, validatePort } from "./security";

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
        "X-Original-URL": request.url,
        "X-Forwarded-Host": url.hostname,
        "X-Forwarded-Proto": url.protocol.replace(":", ""),
        "X-Sandbox-Name": sandboxId // Pass the friendly name
      },
      body: request.body
    });

    return sandbox.containerFetch(proxyRequest, port);
  } catch (error) {
    console.error("[Sandbox] Proxy routing error:", error);
    return new Response("Proxy routing error", { status: 500 });
  }
}

function extractSandboxRoute(url: URL): RouteInfo | null {
  // Parse subdomain pattern: port-sandboxId.domain
  const subdomainMatch = url.hostname.match(
    /^(\d{4,5})-([^.-][^.]*[^.-]|[^.-])\.(.+)$/
  );

  if (!subdomainMatch) {
    // Log malformed subdomain attempts
    if (url.hostname.includes("-") && url.hostname.includes(".")) {
      logSecurityEvent(
        "MALFORMED_SUBDOMAIN_ATTEMPT",
        {
          hostname: url.hostname,
          url: url.toString()
        },
        "medium"
      );
    }
    return null;
  }

  const portStr = subdomainMatch[1];
  const sandboxId = subdomainMatch[2];
  const domain = subdomainMatch[3];

  const port = parseInt(portStr, 10);
  if (!validatePort(port)) {
    logSecurityEvent(
      "INVALID_PORT_IN_SUBDOMAIN",
      {
        port,
        portStr,
        sandboxId,
        hostname: url.hostname,
        url: url.toString()
      },
      "high"
    );
    return null;
  }

  let sanitizedSandboxId: string;
  try {
    sanitizedSandboxId = sanitizeSandboxId(sandboxId);
  } catch (error) {
    logSecurityEvent(
      "INVALID_SANDBOX_ID_IN_SUBDOMAIN",
      {
        sandboxId,
        port,
        hostname: url.hostname,
        url: url.toString(),
        error: error instanceof Error ? error.message : "Unknown error"
      },
      "high"
    );
    return null;
  }

  // DNS subdomain length limit is 63 characters
  if (sandboxId.length > 63) {
    logSecurityEvent(
      "SANDBOX_ID_LENGTH_VIOLATION",
      {
        sandboxId,
        length: sandboxId.length,
        port,
        hostname: url.hostname
      },
      "medium"
    );
    return null;
  }

  logSecurityEvent(
    "SANDBOX_ROUTE_EXTRACTED",
    {
      port,
      sandboxId: sanitizedSandboxId,
      domain,
      path: url.pathname || "/",
      hostname: url.hostname
    },
    "low"
  );

  return {
    port,
    sandboxId: sanitizedSandboxId,
    path: url.pathname || "/"
  };
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
