import {
  Sandbox,
  type SandboxDirectoryEntry,
  SandboxFileError,
  type SandboxFileStat,
  SandboxProtocolError,
} from "@cloudflare/sandbox";

const ACCESSIBLE_PATHS = new Set([
  "/workspace",
  "/workspace/directory",
  "/workspace/directory/nested.txt",
  "/workspace/created",
  "/workspace/created/nested",
  "/workspace/fixture.txt",
  "/workspace/link.txt",
  "/workspace/missing.txt",
  "/workspace/rename-destination.txt",
  "/workspace/rename-source.txt",
  "/workspace/written.txt",
]);
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface Env {
  SANDBOX: DurableObjectNamespace<FilesSandbox>;
  SANDBOX_IMAGE: string;
}

export class FilesSandbox extends Sandbox<Env> {
  /** Streams one allowed file from the example workspace. */
  async readFile(path: string, sandboxName: string): Promise<Response> {
    this.ensureRunning(sandboxName);
    return this.files.readFile(path);
  }

  /** Streams a request body into the writable example file. */
  async writeFile(
    path: string,
    content: ReadableStream<Uint8Array>,
    sandboxName: string,
  ): Promise<void> {
    this.ensureRunning(sandboxName);
    await this.files.writeFile(path, content);
  }

  /** Returns metadata for one allowed workspace path. */
  async stat(path: string, sandboxName: string): Promise<SandboxFileStat> {
    this.ensureRunning(sandboxName);
    return this.files.stat(path);
  }

  /** Returns metadata without following the path's final symlink. */
  async lstat(path: string, sandboxName: string): Promise<SandboxFileStat> {
    this.ensureRunning(sandboxName);
    return this.files.lstat(path);
  }

  /** Returns immediate entries from an allowed workspace directory. */
  async readDirectory(path: string, sandboxName: string): Promise<SandboxDirectoryEntry[]> {
    this.ensureRunning(sandboxName);
    return this.files.readDirectory(path);
  }

  /** Creates an allowed workspace directory. */
  async mkdir(path: string, recursive: boolean, sandboxName: string): Promise<void> {
    this.ensureRunning(sandboxName);
    await this.files.mkdir(path, { recursive });
  }

  /** Renames one allowed workspace path. */
  async rename(source: string, destination: string, sandboxName: string): Promise<void> {
    this.ensureRunning(sandboxName);
    await this.files.rename(source, destination);
  }

  /** Stops and removes this Durable Object's current container instance. */
  async destroyContainer(): Promise<void> {
    const container = this.requireContainer();
    await container.destroy();
  }

  private ensureRunning(sandboxName: string): void {
    const container = this.requireContainer();
    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
        labels: { example: "files", workspace: sandboxName },
      });
    }
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

    const requestedPath = url.searchParams.get("path");
    const defaultPath = url.pathname === "/directory" ? "/workspace" : "/workspace/fixture.txt";
    const path = requestedPath ?? defaultPath;
    if (!ACCESSIBLE_PATHS.has(path)) {
      return new Response("Path is not available in this example", { status: 400 });
    }

    const sandbox = env.SANDBOX.get(env.SANDBOX.idFromName(sandboxName));
    try {
      if (url.pathname === "/execution" && request.method === "DELETE") {
        await sandbox.destroyContainer();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/file" && request.method === "GET") {
        return await sandbox.readFile(path, sandboxName);
      }
      if (url.pathname === "/file" && request.method === "PUT") {
        if (path !== "/workspace/written.txt") {
          return new Response("Only /workspace/written.txt is writable", { status: 400 });
        }
        if (request.body === null) {
          return new Response("Request body is required", { status: 400 });
        }
        await sandbox.writeFile(path, request.body, sandboxName);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/stat" && request.method === "GET") {
        return Response.json(statJson(await sandbox.stat(path, sandboxName)));
      }
      if (url.pathname === "/lstat" && request.method === "GET") {
        return Response.json(statJson(await sandbox.lstat(path, sandboxName)));
      }
      if (url.pathname === "/directory" && request.method === "GET") {
        return Response.json(await sandbox.readDirectory(path, sandboxName));
      }
      if (url.pathname === "/directory" && request.method === "PUT") {
        const recursive = url.searchParams.get("recursive") === "true";
        await sandbox.mkdir(path, recursive, sandboxName);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/rename" && request.method === "POST") {
        if (requestedPath === null) {
          return new Response("Source is required", { status: 400 });
        }
        const destination = url.searchParams.get("destination");
        if (destination === null || !ACCESSIBLE_PATHS.has(destination)) {
          return new Response("Destination is not available in this example", { status: 400 });
        }
        await sandbox.rename(path, destination, sandboxName);
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    } catch (cause) {
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

function statJson(stat: SandboxFileStat) {
  return {
    type: stat.type,
    size: stat.size.toString(),
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    accessedAt: stat.accessedAt.toISOString(),
    modifiedAt: stat.modifiedAt.toISOString(),
    changedAt: stat.changedAt.toISOString(),
  };
}

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    switch (cause.code) {
      case "ENOENT":
        return new Response("Path not found", { status: 404 });
      case "EACCES":
      case "EPERM":
        return new Response("Permission denied", { status: 403 });
      case "EEXIST":
        return new Response("Path already exists", { status: 409 });
      case "EISDIR":
      case "ENOTDIR":
      case "EINVAL":
        return new Response("Path has the wrong file type", { status: 400 });
      default:
        return new Response("Filesystem operation failed", { status: 500 });
    }
  }

  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox protocol failure", { status: 500 });
  }

  return new Response("Sandbox request failed", { status: 500 });
}
