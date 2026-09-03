import { Sandbox, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";

const READABLE_PATHS = new Set(["/fixture.txt", "/missing.txt", "/written.txt"]);
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface Env {
  SANDBOX: DurableObjectNamespace<ReadWriteFilesSandbox>;
  SANDBOX_IMAGE: string;
}

export class ReadWriteFilesSandbox extends Sandbox<Env> {
  /** Starts the example container when needed, then streams one allowed file. */
  async startAndReadFile(path: string, sandboxName: string): Promise<Response> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }

    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
        labels: { example: "read-write", workspace: sandboxName },
      });
    }

    return this.files.readFile(path);
  }

  /** Starts the example container when needed, then streams a request body into a file. */
  async startAndWriteFile(
    path: string,
    content: ReadableStream<Uint8Array>,
    sandboxName: string,
  ): Promise<void> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }

    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
        labels: { example: "read-write", workspace: sandboxName },
      });
    }

    await this.files.writeFile(path, content);
  }

  /** Stops and removes this Durable Object's current container instance. */
  async destroyContainer(): Promise<void> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }

    await container.destroy();
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

    const id = env.SANDBOX.idFromName(sandboxName);
    const sandbox = env.SANDBOX.get(id);
    try {
      if (request.method === "DELETE") {
        await sandbox.destroyContainer();
        return new Response(null, { status: 204 });
      }
      if (request.method !== "GET" && request.method !== "PUT") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, PUT, DELETE" },
        });
      }

      const path = url.searchParams.get("path") ?? "/fixture.txt";
      if (!READABLE_PATHS.has(path)) {
        return new Response("Path is not available in this example", { status: 400 });
      }

      if (request.method === "PUT") {
        if (path !== "/written.txt") {
          return new Response("Only /written.txt is writable in this example", { status: 400 });
        }
        if (request.body === null) {
          return new Response("Request body is required", { status: 400 });
        }
        await sandbox.startAndWriteFile(path, request.body, sandboxName);
        return new Response(null, { status: 204 });
      }

      return await sandbox.startAndReadFile(path, sandboxName);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    switch (cause.code) {
      case "ENOENT":
        return new Response("File not found", { status: 404 });
      case "EACCES":
      case "EPERM":
        return new Response("Permission denied", { status: 403 });
      case "EISDIR":
      case "EINVAL":
        return new Response("Path is not a regular file", { status: 400 });
      default:
        return new Response(
          cause.operation === "writeFile" ? "File could not be written" : "File could not be read",
          { status: 500 },
        );
    }
  }

  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox protocol failure", { status: 500 });
  }

  return new Response("Sandbox request failed", { status: 500 });
}
