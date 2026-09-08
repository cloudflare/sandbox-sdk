import { DurableObject } from "cloudflare:workers";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
const ALLOWED_COMMANDS = new Set(["uname -a", "cat /etc/os-release"]);

interface Env {
  SANDBOX: DurableObjectNamespace<CommandExecSandbox>;
  SANDBOX_IMAGE: string;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecWireValue {
  argv?: unknown;
}

export class CommandExecSandbox extends DurableObject<Env> {
  /** Starts one physical execution for this logical sandbox. */
  async start(sandboxName: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) return;
    container.start({
      image: this.env.SANDBOX_IMAGE,
      instance: "lite",
      enableInternet: false,
      labels: { example: "command-exec", workspace: sandboxName },
    });
    await container.setInactivityTimeout(DEFAULT_INACTIVITY_TIMEOUT_MS);
  }

  /** Runs one allowed argv and waits for its output in this request. */
  async exec(argv: string[]): Promise<ExecResult> {
    const container = this.requireContainer();
    if (!container.running) throw new Error("container is not running");
    const process = await container.exec(argv);
    const output = await process.output();
    return {
      exitCode: output.exitCode,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }

  /** Immediately destroys the current physical execution. */
  async destroy(): Promise<void> {
    await this.requireContainer().destroy();
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
    if (url.pathname === "/exec" && request.method === "POST") {
      const argv = await readArgv(request);
      if (argv === null || !ALLOWED_COMMANDS.has(argv.join(" "))) {
        return new Response('argv must be ["uname","-a"] or ["cat","/etc/os-release"]', {
          status: 400,
        });
      }
      return Response.json(await sandbox.exec(argv));
    }
    if (url.pathname === "/execution" && request.method === "DELETE") {
      await sandbox.destroy();
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function readArgv(request: Request): Promise<string[] | null> {
  const parsed: unknown = await request.json();
  if (Object.prototype.toString.call(parsed) !== "[object Object]") return null;
  // SAFETY: The object tag above establishes a non-null plain object. argv is
  // independently validated as an array of strings before being returned.
  const value = parsed as ExecWireValue;
  if (!Array.isArray(value.argv)) return null;
  if (!value.argv.every((item) => Object.prototype.toString.call(item) === "[object String]")) {
    return null;
  }
  return value.argv;
}
