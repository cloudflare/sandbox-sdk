import { DurableObject } from "cloudflare:workers";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const SERVICE_PORT = 8080;

interface Env {
  SANDBOX: DurableObjectNamespace<ServiceForwardingSandbox>;
  SANDBOX_IMAGE: string;
}

export class ServiceForwardingSandbox extends DurableObject<Env> {
  /** Starts one physical execution for this logical sandbox. */
  async start(sandboxName: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) return;
    container.start({
      image: this.env.SANDBOX_IMAGE,
      instance: "lite",
      enableInternet: false,
      labels: { example: "service-forwarding", workspace: sandboxName },
    });
    await container.setInactivityTimeout(DEFAULT_INACTIVITY_TIMEOUT_MS);
  }

  /** Immediately destroys the current physical execution. */
  async destroy(): Promise<void> {
    const container = this.requireContainer();
    if (container.running) await container.destroy();
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.requireContainer();
    if (!container.running) return new Response("container is not running", { status: 409 });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/service")) return new Response("Not found", { status: 404 });
    url.protocol = "http:";
    url.pathname = url.pathname.slice("/service".length) || "/";
    return container.getTcpPort(SERVICE_PORT).fetch(forwardedRequest(url, request));
  }

  private requireContainer(): Container {
    const container = this.ctx.container;
    if (container === undefined) throw new Error("Container attachment is unavailable");
    return container;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const sandboxName = url.searchParams.get("sandbox");
    if (sandboxName === null || !SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandbox = env.SANDBOX.get(env.SANDBOX.idFromName(sandboxName));
    if (url.pathname === "/start" && request.method === "POST") {
      await sandbox.start(sandboxName);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/execution" && request.method === "DELETE") {
      await sandbox.destroy();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/service" || url.pathname.startsWith("/service/")) {
      return await sandbox.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function forwardedRequest(url: URL, request: Request): Request {
  const forwarded = new Request(url, request);
  // Native port fetch preserves inbound credentials. This example consumes Access at
  // the Worker boundary and keeps those headers out of guest code.
  forwarded.headers.delete("cf-access-jwt-assertion");
  forwarded.headers.delete("cf-access-token");
  forwarded.headers.delete("cf-access-authenticated-user-email");
  forwarded.headers.delete("cf-access-client-id");
  forwarded.headers.delete("cf-access-client-secret");
  const cookie = forwarded.headers.get("cookie");
  if (cookie !== null) {
    const retained = cookie
      .split(";")
      .map((value) => value.trim())
      .filter((value) => !value.toLowerCase().startsWith("cf_authorization="));
    if (retained.length === 0) forwarded.headers.delete("cookie");
    else forwarded.headers.set("cookie", retained.join("; "));
  }
  return forwarded;
}
