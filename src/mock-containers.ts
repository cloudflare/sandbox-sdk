type MockStatus = "healthy" | "stopped";

type MockRuntime = {
  status: MockStatus;
  lastChange: number;
  starts: number;
  requests: string[];
};

const RUNTIME_KEY = "issue-825:mock-runtime";

function initialRuntime(): MockRuntime {
  return {
    status: "healthy",
    lastChange: Date.now(),
    starts: 0,
    requests: []
  };
}

/**
 * Minimal platform boundary used by the deployed demo.
 *
 * The class under test remains the real Sandbox class from
 * @cloudflare/sandbox@0.12.3. This mock replaces only the unavailable
 * Cloudflare Container runtime in temporary preview accounts.
 */
export class Container<Env = unknown> {
  ctx: DurableObjectState;
  env: Env;
  sleepAfter: string | number = "10m";
  defaultPort?: number;
  envVars: Record<string, string> = {};
  inflightRequests = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private async runtime(): Promise<MockRuntime> {
    return (await this.ctx.storage.get<MockRuntime>(RUNTIME_KEY)) ?? initialRuntime();
  }

  private async save(runtime: MockRuntime): Promise<void> {
    await this.ctx.storage.put(RUNTIME_KEY, runtime);
  }

  async resetMockRuntime(status: MockStatus = "healthy"): Promise<void> {
    await this.save({ ...initialRuntime(), status });
  }

  async getMockRuntime(): Promise<MockRuntime> {
    return this.runtime();
  }

  async getState() {
    const runtime = await this.runtime();
    return { status: runtime.status, lastChange: runtime.lastChange };
  }

  async startAndWaitForPorts(): Promise<void> {
    const runtime = await this.runtime();
    await this.save({
      ...runtime,
      status: "healthy",
      lastChange: Date.now(),
      starts: runtime.starts + 1
    });
  }

  async stop(): Promise<void> {
    const runtime = await this.runtime();
    await this.save({ ...runtime, status: "stopped", lastChange: Date.now() });
  }

  async destroy(): Promise<void> {
    await this.stop();
  }

  renewActivityTimeout(): void {}

  async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    _portParam?: number
  ): Promise<Response> {
    const request =
      requestOrUrl instanceof Request
        ? requestOrUrl
        : new Request(
            requestOrUrl.toString(),
            typeof portOrInit === "number" ? undefined : portOrInit
          );
    const path = new URL(request.url).pathname;
    const runtime = await this.runtime();
    await this.save({ ...runtime, requests: [...runtime.requests, path] });

    if (path === "/api/session/create") {
      const body: { id?: string } = await request
        .clone()
        .json<{ id?: string }>()
        .catch(() => ({}));
      return Response.json({
        success: true,
        id: body.id ?? "backup-session",
        message: "Created"
      });
    }

    if (path === "/api/backup/create") {
      const body: { archivePath?: string } = await request
        .clone()
        .json<{ archivePath?: string }>()
        .catch(() => ({}));
      return Response.json({
        success: true,
        archivePath: body.archivePath ?? "/var/backups/repro.sqsh",
        sizeBytes: 4
      });
    }

    if (path === "/api/read/stream") {
      const payload = [
        `data: ${JSON.stringify({ type: "metadata", mimeType: "application/octet-stream", size: 4, isBinary: true, encoding: "base64" })}\n\n`,
        `data: ${JSON.stringify({ type: "chunk", data: "aHNxcw==" })}\n\n`,
        `data: ${JSON.stringify({ type: "complete" })}\n\n`
      ].join("");
      return new Response(payload, {
        headers: { "content-type": "text/event-stream" }
      });
    }

    if (path === "/api/execute") {
      return Response.json({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        command: "rm",
        timestamp: new Date().toISOString()
      });
    }

    if (path === "/api/session/delete") {
      return Response.json({
        success: true,
        sessionId: "backup-session",
        timestamp: new Date().toISOString()
      });
    }

    return new Response(`Unexpected mock container path: ${path}`, { status: 404 });
  }

  async fetch(): Promise<Response> {
    return new Response("Mock container fetch is not used", { status: 404 });
  }
}

export class ContainerProxy {
  constructor(..._args: unknown[]) {}
}

export function getContainer(
  namespace: DurableObjectNamespace,
  name: string
) {
  return namespace.get(namespace.idFromName(name));
}

export function switchPort(request: Request): Request {
  return request;
}
