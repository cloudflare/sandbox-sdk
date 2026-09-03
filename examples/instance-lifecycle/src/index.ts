import { Sandbox } from "@cloudflare/sandbox";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
const SIGTERM = 15;

interface Env {
  SANDBOX: DurableObjectNamespace<InstanceLifecycleSandbox>;
  SANDBOX_IMAGE: string;
}

export class InstanceLifecycleSandbox extends Sandbox<Env> {
  /** Starts one physical execution for this logical sandbox and configures idle shutdown. */
  async start(sandboxName: string): Promise<void> {
    const container = this.requireContainer();
    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
        labels: { example: "lifecycle", workspace: sandboxName },
      });
      await container.setInactivityTimeout(DEFAULT_INACTIVITY_TIMEOUT_MS);
    }
  }

  /** Changes the native inactivity timeout without introducing SDK policy. */
  async setInactivityTimeout(durationMs: number): Promise<void> {
    await this.requireContainer().setInactivityTimeout(durationMs);
  }

  /** Requests graceful process termination and waits for the execution to exit. */
  async terminate(): Promise<void> {
    const container = this.requireContainer();
    container.signal(SIGTERM);
    await container.monitor();
  }

  /** Immediately destroys the current physical execution. */
  async destroy(): Promise<void> {
    await this.requireContainer().destroy();
  }

  private requireContainer(): Container {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }
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
    if (url.pathname === "/inactivity" && request.method === "POST") {
      const durationMs = Number(url.searchParams.get("ms"));
      if (!Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 300_000) {
        return new Response("ms must be an integer from 1000 through 300000", { status: 400 });
      }
      await sandbox.setInactivityTimeout(durationMs);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/terminate" && request.method === "POST") {
      await sandbox.terminate();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/execution" && request.method === "DELETE") {
      await sandbox.destroy();
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
