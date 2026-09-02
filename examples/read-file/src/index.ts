import { Sandbox, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";

const READABLE_PATHS = new Set(["/fixture.txt", "/missing.txt"]);

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

    if (!container.running) {
      container.start({
        image: this.env.SANDBOX_IMAGE,
        instance: "lite",
        enableInternet: false,
      });
    }

    return this.files.readFile(path);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "/fixture.txt";
    if (!READABLE_PATHS.has(path)) {
      return new Response("Path is not available in this example", { status: 400 });
    }

    const id = env.SANDBOX.idFromName("read-file-example");
    try {
      return await env.SANDBOX.get(id).startAndReadFile(path);
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
