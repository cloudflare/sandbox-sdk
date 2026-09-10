import { Files, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

const ACTIVE_CHECKPOINT_KEY = "active-container-checkpoint";
const WORKSPACE_FILE = "/workspace/message.txt";
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface ActiveCheckpoint {
  id: string;
}

interface CheckpointResult {
  id: string;
  name: string | null;
  size: number;
}

interface Env {
  SANDBOX: DurableObjectNamespace<CheckpointSandbox>;
  SANDBOX_IMAGE: string;
}

export class CheckpointSandbox extends DurableObject<Env> {
  readonly files: Files;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.files = new Files(this.requireContainer());
  }

  async writeWorkspace(content: ReadableStream<Uint8Array>, sandboxName: string): Promise<void> {
    await this.ensureExecution(sandboxName);
    await this.files.writeFile(WORKSPACE_FILE, content);
  }

  async readWorkspace(sandboxName: string): Promise<Response> {
    await this.ensureExecution(sandboxName);
    return this.files.readFile(WORKSPACE_FILE);
  }

  async checkpoint(sandboxName: string): Promise<CheckpointResult> {
    const container = await this.ensureExecution(sandboxName);
    const snapshot = await container.snapshotContainer({});
    await this.ctx.storage.put<ActiveCheckpoint>(ACTIVE_CHECKPOINT_KEY, { id: snapshot.id });
    await container.destroy();
    return { id: snapshot.id, size: snapshot.size, name: snapshot.name ?? null };
  }

  async restoreFrom(snapshotID: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) {
      throw new Error("Reset the current execution before selecting another checkpoint");
    }
    await this.ctx.storage.put<ActiveCheckpoint>(ACTIVE_CHECKPOINT_KEY, { id: snapshotID });
  }

  async resetWorkspace(): Promise<void> {
    const container = this.requireContainer();
    if (container.running) await container.destroy();
    await this.ctx.storage.delete(ACTIVE_CHECKPOINT_KEY);
  }

  private async ensureExecution(sandboxName: string): Promise<Container> {
    const container = this.requireContainer();
    if (container.running) return container;

    const checkpoint = await this.ctx.storage.get<ActiveCheckpoint>(ACTIVE_CHECKPOINT_KEY);
    const commonOptions = {
      instance: "lite" as const,
      enableInternet: false,
      labels: { example: "checkpoint-workspace", sandbox: sandboxName },
    };
    if (checkpoint === undefined) {
      container.start({ image: this.env.SANDBOX_IMAGE, ...commonOptions });
    } else {
      container.start({ containerSnapshot: { id: checkpoint.id }, ...commonOptions });
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
    const match = /^\/sandboxes\/([^/]+)\/(workspace|checkpoint|restore)$/.exec(url.pathname);
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
      if (resource === "workspace" && request.method === "GET") {
        return await sandbox.readWorkspace(sandboxName);
      }
      if (resource === "workspace" && request.method === "PUT") {
        if (request.body === null) {
          return new Response("Request body is required", { status: 400 });
        }
        await sandbox.writeWorkspace(request.body, sandboxName);
        return new Response(null, { status: 204 });
      }
      if (resource === "checkpoint" && request.method === "POST") {
        return Response.json(await sandbox.checkpoint(sandboxName));
      }
      if (resource === "restore" && request.method === "POST") {
        const snapshotID = url.searchParams.get("snapshot");
        if (snapshotID === null || snapshotID.length === 0 || snapshotID.length > 256) {
          return new Response("snapshot must contain a non-empty snapshot ID", { status: 400 });
        }
        await sandbox.restoreFrom(snapshotID);
        return new Response(null, { status: 204 });
      }
      if (resource === "workspace" && request.method === "DELETE") {
        await sandbox.resetWorkspace();
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
    const missing = cause.code === "ENOENT";
    return new Response(missing ? "Workspace state not found" : "Workspace file operation failed", {
      status: missing ? 404 : 500,
    });
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox file protocol failed", { status: 500 });
  }
  return new Response("Sandbox checkpoint operation failed", { status: 500 });
}
