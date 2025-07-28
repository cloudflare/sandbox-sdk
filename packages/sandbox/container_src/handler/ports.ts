import type { ExposePortRequest, UnexposePortRequest } from "../types";

export async function handleExposePortRequest(
  exposedPorts: Map<number, { name?: string; exposedAt: Date }>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await req.json()) as ExposePortRequest;
    const { port, name } = body;

    if (!port || typeof port !== "number") {
      return new Response(
        JSON.stringify({
          error: "Port is required and must be a number",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 400,
        }
      );
    }

    // Validate port range
    if (port < 1 || port > 65535) {
      return new Response(
        JSON.stringify({
          error: "Port must be between 1 and 65535",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 400,
        }
      );
    }

    // Store the exposed port
    exposedPorts.set(port, { name, exposedAt: new Date() });

    console.log(`[Server] Exposed port: ${port}${name ? ` (${name})` : ""}`);

    return new Response(
      JSON.stringify({
        port,
        name,
        exposedAt: new Date().toISOString(),
        success: true,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleExposePortRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to expose port",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
        status: 500,
      }
    );
  }
}

export async function handleUnexposePortRequest(
  exposedPorts: Map<number, { name?: string; exposedAt: Date }>,
  req: Request,
  corsHeaders: Record<string, string>,
  port: number
): Promise<Response> {
  try {
    if (!port || typeof port !== "number" || port <= 0) {
      return new Response(
        JSON.stringify({
          error: "Port is required and must be a valid positive number",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 400,
        }
      );
    }

    // Check if port is exposed
    if (!exposedPorts.has(port)) {
      return new Response(
        JSON.stringify({
          error: "Port is not exposed",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 404,
        }
      );
    }

    // Remove the exposed port
    exposedPorts.delete(port);

    console.log(`[Server] Unexposed port: ${port}`);

    return new Response(
      JSON.stringify({
        port,
        success: true,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleUnexposePortRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to unexpose port",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
        status: 500,
      }
    );
  }
}

export async function handleGetExposedPortsRequest(
  exposedPorts: Map<number, { name?: string; exposedAt: Date }>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const ports = Array.from(exposedPorts.entries()).map(([port, info]) => ({
      port,
      name: info.name,
      exposedAt: info.exposedAt.toISOString(),
    }));

    return new Response(
      JSON.stringify({
        ports,
        count: ports.length,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleGetExposedPortsRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to get exposed ports",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
        status: 500,
      }
    );
  }
}

export async function handleProxyRequest(
  exposedPorts: Map<number, { name?: string; exposedAt: Date }>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/");

    // Extract port from path like /proxy/3000/...
    if (pathParts.length < 3) {
      return new Response(
        JSON.stringify({
          error: "Invalid proxy path",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 400,
        }
      );
    }

    const port = parseInt(pathParts[2]);
    if (!port || Number.isNaN(port)) {
      return new Response(
        JSON.stringify({
          error: "Invalid port in proxy path",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 400,
        }
      );
    }

    // Check if port is exposed
    if (!exposedPorts.has(port)) {
      return new Response(
        JSON.stringify({
          error: `Port ${port} is not exposed`,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 404,
        }
      );
    }

    // Construct the target URL
    const targetPath = `/${pathParts.slice(3).join("/")}`;
    // Use 127.0.0.1 instead of localhost for more reliable container networking
    const targetUrl = `http://127.0.0.1:${port}${targetPath}${url.search}`;

    console.log(`[Server] Proxying request to: ${targetUrl}`);
    console.log(`[Server] Method: ${req.method}, Port: ${port}, Path: ${targetPath}`);

    try {
      // Forward the request to the target port
      const targetResponse = await fetch(targetUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });

      // Return the response from the target
      return new Response(targetResponse.body, {
        status: targetResponse.status,
        statusText: targetResponse.statusText,
        headers: {
          ...Object.fromEntries(targetResponse.headers.entries()),
          ...corsHeaders,
        },
      });
    } catch (fetchError) {
      console.error(`[Server] Error proxying to port ${port}:`, fetchError);
      return new Response(
        JSON.stringify({
          error: `Service on port ${port} is not responding`,
          message: fetchError instanceof Error ? fetchError.message : "Unknown error",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 502,
        }
      );
    }
  } catch (error) {
    console.error("[Server] Error in handleProxyRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to proxy request",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
        status: 500,
      }
    );
  }
}
