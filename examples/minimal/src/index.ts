import { Files, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKSPACE_DIRECTORY = "/workspace";
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

const ExecRequest = z.object({ argv: z.array(z.string()).min(1) });

interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class Sandbox extends DurableObject<Env> {
  readonly files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = this.requireContainer();
    this.files = new Files(container);
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (container.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  async writeFile(path: string, contents: ReadableStream<Uint8Array>): Promise<void> {
    await this.ensureRunning();
    await this.files.writeFile(path, contents);
  }

  async readFile(path: string): Promise<Response> {
    await this.ensureRunning();
    return this.files.readFile(path);
  }

  async exec(argv: string[]): Promise<CommandResult> {
    const container = await this.ensureRunning();
    const process = await container.exec(argv, { cwd: WORKSPACE_DIRECTORY });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  async destroy(): Promise<void> {
    const container = this.requireContainer();
    if (container.running) await container.destroy();
  }

  private async ensureRunning(): Promise<Container> {
    const container = this.requireContainer();
    if (!container.running) {
      container.start({
        image: container.images.sandbox,
        instance: "lite",
        enableInternet: false,
      });
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
    return container;
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
    const match = /^\/sandboxes\/([^/]+)(\/exec|\/files(\/.+))?$/.exec(url.pathname);
    if (match === null) return new Response("Not found", { status: 404 });

    const sandboxName = match[1];
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    const filePath = match[3] === undefined ? undefined : workspacePath(match[3]);
    if (match[3] !== undefined && filePath === undefined) {
      return new Response("Invalid file path", { status: 400 });
    }
    try {
      if (match[2] === "/exec" && request.method === "POST") {
        const { argv } = ExecRequest.parse(await request.json());
        return Response.json(await sandbox.exec(argv));
      }
      if (filePath !== undefined && request.method === "PUT") {
        if (request.body === null) {
          return new Response("Request body is required", { status: 400 });
        }
        await sandbox.writeFile(filePath, request.body);
        return new Response(null, { status: 204 });
      }
      if (filePath !== undefined && request.method === "GET") {
        return await sandbox.readFile(filePath);
      }
      if (match[2] === undefined && request.method === "DELETE") {
        await sandbox.destroy();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      if (cause instanceof SyntaxError || cause instanceof z.ZodError) {
        return new Response('Body must be JSON such as {"argv": ["ls", "-la"]}', { status: 400 });
      }
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        path: url.pathname,
        error: describeError(cause),
      });
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

// Files follows Linux path rules and enforces no policy, so the Worker keeps paths in /workspace.
function workspacePath(routePath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(routePath);
  } catch {
    return undefined;
  }
  const segments = decoded.split("/").slice(1);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return `${WORKSPACE_DIRECTORY}/${segments.join("/")}`;
}

// Structured logs drop an Error's message and stack because they are not enumerable.
function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    if (cause.code === "ENOENT") return new Response("No such file or directory", { status: 404 });
    if (cause.code === "EACCES" || cause.code === "EPERM") {
      return new Response("Permission denied", { status: 403 });
    }
    return new Response("File operation failed", { status: 500 });
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox file protocol failed", { status: 500 });
  }
  return new Response("Sandbox request failed", { status: 500 });
}
