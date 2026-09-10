import { Files, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKSPACE_DIRECTORY = "/workspace";
const SOURCE_PATH = `${WORKSPACE_DIRECTORY}/task.sh`;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

interface Env {
  SANDBOX: DurableObjectNamespace<WorkspaceSandbox>;
  SANDBOX_IMAGE: string;
}

interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class WorkspaceSandbox extends DurableObject<Env> {
  readonly files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.files = new Files(this.requireContainer());
  }

  async writeSource(source: ReadableStream<Uint8Array>, sandboxName: string): Promise<void> {
    await this.ensureExecution(sandboxName);
    await this.files.writeFile(SOURCE_PATH, source);
  }

  async readSource(sandboxName: string): Promise<Response> {
    await this.ensureExecution(sandboxName);
    return this.files.readFile(SOURCE_PATH);
  }

  async runTask(sandboxName: string): Promise<TaskResult> {
    const container = await this.ensureExecution(sandboxName);
    const process = await container.exec(["/bin/sh", SOURCE_PATH], {
      cwd: WORKSPACE_DIRECTORY,
    });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  async resetExecution(): Promise<void> {
    const container = this.requireContainer();
    if (container.running) await container.destroy();
  }

  private async ensureExecution(sandboxName: string): Promise<Container> {
    const container = this.requireContainer();
    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
        labels: { example: "code-workspace", sandbox: sandboxName },
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
    const match = /^\/sandboxes\/([^/]+)\/(source|run|execution)$/.exec(url.pathname);
    if (match === null) return new Response("Not found", { status: 404 });

    const sandboxName = match[1];
    const resource = match[2];
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      if (resource === "source" && request.method === "PUT") {
        if (request.body === null) {
          return new Response("Request body is required", { status: 400 });
        }
        await sandbox.writeSource(request.body, sandboxName);
        return new Response(null, { status: 204 });
      }
      if (resource === "source" && request.method === "GET") {
        return await sandbox.readSource(sandboxName);
      }
      if (resource === "run" && request.method === "POST") {
        return Response.json(await sandbox.runTask(sandboxName));
      }
      if (resource === "execution" && request.method === "DELETE") {
        await sandbox.resetExecution();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      console.error({ event: "sandbox.request.failed", sandboxName, resource, cause });
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    if (cause.code === "ENOENT") return new Response("Workspace source not found", { status: 404 });
    if (cause.code === "EACCES" || cause.code === "EPERM") {
      return new Response("Workspace permission denied", { status: 403 });
    }
    return new Response("Workspace file operation failed", { status: 500 });
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox file protocol failed", { status: 500 });
  }
  return new Response("Sandbox task failed", { status: 500 });
}
