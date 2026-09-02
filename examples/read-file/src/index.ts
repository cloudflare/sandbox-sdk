import { Sandbox, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";

const READABLE_PATHS = new Set(["/fixture.txt", "/missing.txt"]);
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface Env {
  SANDBOX: DurableObjectNamespace<ReadFileSandbox>;
  SANDBOX_IMAGE: string;
}

export class ReadFileSandbox extends Sandbox<Env> {
  /** Starts the example container when needed, then streams one allowed file. */
  async startAndReadFile(path: string): Promise<Response> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }

    const durableObjectID = this.ctx.id.toString();
    console.log({
      event: "sandbox.read.requested",
      durableObjectID,
      path,
      running: container.running,
    });
    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
      });
      console.log({ event: "sandbox.container.start-requested", durableObjectID });
    }

    const response = await this.files.readFile(path);
    console.log({ event: "sandbox.read.response-ready", durableObjectID, path });
    return response;
  }

  /** Stops and removes this Durable Object's current container instance. */
  async destroyContainer(): Promise<void> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }

    const durableObjectID = this.ctx.id.toString();
    console.log({ event: "sandbox.container.destroy-requested", durableObjectID });
    await container.destroy();
    console.log({ event: "sandbox.container.destroyed", durableObjectID });
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
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, DELETE" },
        });
      }

      const path = url.searchParams.get("path") ?? "/fixture.txt";
      if (!READABLE_PATHS.has(path)) {
        return new Response("Path is not available in this example", { status: 400 });
      }

      return await sandbox.startAndReadFile(path);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    switch (cause.code) {
      case "FILE_NOT_FOUND":
        return new Response("File not found", { status: 404 });
      case "PERMISSION_DENIED":
        return new Response("Permission denied", { status: 403 });
      case "NOT_A_REGULAR_FILE":
        return new Response("Path is not a regular file", { status: 400 });
      case "FILE_READ_ERROR":
        return new Response("File could not be read", { status: 500 });
    }
  }

  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox protocol failure", { status: 500 });
  }

  return new Response("Sandbox request failed", { status: 500 });
}
