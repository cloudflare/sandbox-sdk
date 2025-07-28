import { mapPortError, createErrorResponse, SandboxOperation } from "../utils/error-mapping";
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
      const errorData = {
        error: "Port is required and must be a number",
        code: 'INVALID_PORT_NUMBER',
        operation: SandboxOperation.PORT_EXPOSE,
        httpStatus: 400,
        details: 'Port parameter is missing or not a valid number'
      };
      return createErrorResponse(errorData, corsHeaders);
    }

    // Validate port range
    if (port < 1 || port > 65535) {
      const errorData = {
        error: `Invalid port number: ${port}`,
        code: 'INVALID_PORT_NUMBER',
        operation: SandboxOperation.PORT_EXPOSE,
        httpStatus: 400,
        details: `Port must be between 1 and 65535, got ${port}`
      };
      return createErrorResponse(errorData, corsHeaders);
    }

    // Check if port is already exposed
    if (exposedPorts.has(port)) {
      const errorData = {
        error: `Port already exposed: ${port}`,
        code: 'PORT_ALREADY_EXPOSED',
        operation: SandboxOperation.PORT_EXPOSE,
        httpStatus: 409,
        details: `Port ${port} is already exposed and cannot be exposed again`
      };
      return createErrorResponse(errorData, corsHeaders);
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
    const errorData = mapPortError(error, SandboxOperation.PORT_EXPOSE);
    return createErrorResponse(errorData, corsHeaders);
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
      const errorData = {
        error: "Port is required and must be a valid positive number",
        code: 'INVALID_PORT_NUMBER',
        operation: SandboxOperation.PORT_UNEXPOSE,
        httpStatus: 400,
        details: `Invalid port parameter: ${port}`
      };
      return createErrorResponse(errorData, corsHeaders);
    }

    // Check if port is exposed
    if (!exposedPorts.has(port)) {
      const errorData = {
        error: `Port not exposed: ${port}`,
        code: 'PORT_NOT_EXPOSED',
        operation: SandboxOperation.PORT_UNEXPOSE,
        httpStatus: 404,
        details: `Port ${port} is not currently exposed and cannot be unexposed`
      };
      return createErrorResponse(errorData, corsHeaders);
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
    const errorData = mapPortError(error, SandboxOperation.PORT_UNEXPOSE, port);
    return createErrorResponse(errorData, corsHeaders);
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
    const errorData = mapPortError(error, SandboxOperation.PORT_LIST);
    return createErrorResponse(errorData, corsHeaders);
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
      const errorData = {
        error: "Invalid proxy path",
        code: 'INVALID_PROXY_PATH',
        operation: SandboxOperation.PORT_PROXY,
        httpStatus: 400,
        details: `Proxy path must include port: /proxy/{port}/path, got ${url.pathname}`
      };
      return createErrorResponse(errorData, corsHeaders);
    }

    const port = parseInt(pathParts[2]);
    if (!port || Number.isNaN(port)) {
      const errorData = {
        error: `Invalid port in proxy path: ${pathParts[2]}`,
        code: 'INVALID_PORT_NUMBER',
        operation: SandboxOperation.PORT_PROXY,
        httpStatus: 400,
        details: `Port must be a valid number, got "${pathParts[2]}"`
      };
      return createErrorResponse(errorData, corsHeaders);
    }

    // Check if port is exposed
    if (!exposedPorts.has(port)) {
      const errorData = {
        error: `Port not exposed: ${port}`,
        code: 'PORT_NOT_EXPOSED',
        operation: SandboxOperation.PORT_PROXY,
        httpStatus: 404,
        details: `Cannot proxy to port ${port} because it is not currently exposed`
      };
      return createErrorResponse(errorData, corsHeaders);
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
      const errorData = {
        error: `Service on port ${port} is not responding`,
        code: 'SERVICE_NOT_RESPONDING',
        operation: SandboxOperation.PORT_PROXY,
        httpStatus: 502,
        details: `Failed to connect to service on port ${port}: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`
      };
      return createErrorResponse(errorData, corsHeaders);
    }
  } catch (error) {
    console.error("[Server] Error in handleProxyRequest:", error);
    const errorData = mapPortError(error, SandboxOperation.PORT_PROXY);
    return createErrorResponse(errorData, corsHeaders);
  }
}
