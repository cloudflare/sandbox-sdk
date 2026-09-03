import { Sandbox, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";

const ACTIVE_SNAPSHOT_KEY = "active-container-snapshot";
const WORKSPACE_FILE = "/workspace/message.txt";
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface ActiveSnapshot {
  id: string;
}

interface SnapshotResult {
  id: string;
  name: string | null;
  size: number;
}

interface Env {
  SANDBOX: DurableObjectNamespace<SnapshotRestoreSandbox>;
  SANDBOX_IMAGE: string;
}

export class SnapshotRestoreSandbox extends Sandbox<Env> {
  /** Starts from this sandbox's active checkpoint, or from its configured image. */
  async start(sandboxName: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) {
      return;
    }

    const activeSnapshot = await this.ctx.storage.get<ActiveSnapshot>(ACTIVE_SNAPSHOT_KEY);
    const commonOptions = {
      instance: "lite" as const,
      enableInternet: false,
      labels: { example: "snapshot", workspace: sandboxName },
    };
    if (activeSnapshot === undefined) {
      container.start({ image: this.env.SANDBOX_IMAGE, ...commonOptions });
      return;
    }

    container.start({ containerSnapshot: { id: activeSnapshot.id }, ...commonOptions });
  }

  /** Streams new workspace contents into the running container. */
  async write(content: ReadableStream<Uint8Array>, sandboxName: string): Promise<void> {
    await this.start(sandboxName);
    await this.files.writeFile(WORKSPACE_FILE, content);
  }

  /** Reads the workspace, restoring the active checkpoint first when necessary. */
  async read(sandboxName: string): Promise<Response> {
    await this.start(sandboxName);
    return await this.files.readFile(WORKSPACE_FILE);
  }

  /** Adopts a successful full-container snapshot as this sandbox's active checkpoint. */
  async checkpoint(sandboxName: string): Promise<SnapshotResult> {
    await this.start(sandboxName);
    const container = this.requireContainer();
    const snapshot = await container.snapshotContainer({});

    await this.ctx.storage.put<ActiveSnapshot>(ACTIVE_SNAPSHOT_KEY, { id: snapshot.id });
    await container.destroy();

    return { id: snapshot.id, size: snapshot.size, name: snapshot.name ?? null };
  }

  /** Records an explicit snapshot for a new, currently stopped sandbox. */
  async restoreFrom(snapshotID: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) {
      throw new Error("Destroy the current execution before selecting another snapshot");
    }

    await this.ctx.storage.put<ActiveSnapshot>(ACTIVE_SNAPSHOT_KEY, { id: snapshotID });
  }

  /** Removes both the physical execution and this sandbox's resume pointer. */
  async reset(): Promise<void> {
    const container = this.requireContainer();
    if (container.running) {
      await container.destroy();
    }
    await this.ctx.storage.delete(ACTIVE_SNAPSHOT_KEY);
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
    try {
      if (url.pathname === "/workspace" && request.method === "GET") {
        return await sandbox.read(sandboxName);
      }
      if (url.pathname === "/workspace" && request.method === "PUT") {
        if (request.body === null) {
          return new Response("Request body is required", { status: 400 });
        }
        await sandbox.write(request.body, sandboxName);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/checkpoint" && request.method === "POST") {
        return Response.json(await sandbox.checkpoint(sandboxName));
      }
      if (url.pathname === "/restore" && request.method === "POST") {
        const snapshotID = url.searchParams.get("snapshot");
        if (snapshotID === null || snapshotID.length === 0 || snapshotID.length > 256) {
          return new Response("snapshot must contain a non-empty snapshot ID", { status: 400 });
        }
        await sandbox.restoreFrom(snapshotID);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/workspace" && request.method === "DELETE") {
        await sandbox.reset();
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    } catch (cause) {
      console.error({ event: "snapshot-example.request.failed", cause });
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    return new Response(
      cause.code === "ENOENT" ? "Workspace file not found" : "File operation failed",
      {
        status: cause.code === "ENOENT" ? 404 : 500,
      },
    );
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox protocol failure", { status: 500 });
  }
  throw cause;
}
