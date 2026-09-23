import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { terminalPage } from "./page.js";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKSPACE_DIRECTORY = "/workspace";
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

const TerminalSize = z.object({
  cols: z.int().min(1).max(500),
  rows: z.int().min(1).max(500),
});

interface Env {
  SANDBOX: DurableObjectNamespace<TerminalSandbox>;
}

export class TerminalSandbox extends DurableObject<Env> {
  readonly #container: Container;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async resetExecution(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  // Each WebSocket gets its own shell in this sandbox's Container.
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const size = TerminalSize.safeParse({
      cols: Number(url.searchParams.get("cols") ?? 80),
      rows: Number(url.searchParams.get("rows") ?? 24),
    });
    if (!size.success) {
      return new Response("cols and rows must be integers from 1 through 500", { status: 400 });
    }

    const sandboxName = url.searchParams.get("sandbox") ?? "";
    this.#ensureExecution(sandboxName);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const abort = new AbortController();
    const shell = await this.#container.exec(["bash", "--login"], {
      pty: size.data,
      env: { TERM: "xterm-256color" },
      cwd: WORKSPACE_DIRECTORY,
      signal: abort.signal,
    });
    if (shell.stdin === null || shell.stdout === null) {
      abort.abort();
      throw new Error("exec() did not return the terminal streams");
    }

    const [client, server] = Object.values(new WebSocketPair());
    // Binary messages arrive as Blob unless the socket asks for ArrayBuffer.
    server.binaryType = "arraybuffer";
    // A hibernating WebSocket would discard the shell's process handle.
    // An accepted one keeps this instance, and the handle, in memory.
    server.accept();
    bridge(server, shell, shell.stdin, shell.stdout, abort);
    return new Response(null, { status: 101, webSocket: client });
  }

  #ensureExecution(sandboxName: string): void {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "lite",
      enableInternet: false,
      labels: { example: "terminal-workspace", sandbox: sandboxName },
    });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/sandboxes\/([^/]+)\/(terminal|execution)?$/.exec(url.pathname);
    if (match === null) return new Response("Not found", { status: 404 });

    const sandboxName = match[1];
    const resource = match[2];
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    if (resource === undefined && request.method === "GET") {
      return new Response(terminalPage, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      if (resource === "terminal" && request.method === "GET") {
        url.searchParams.set("sandbox", sandboxName);
        return await sandbox.fetch(new Request(url, request));
      }
      if (resource === "execution" && request.method === "DELETE") {
        await sandbox.resetExecution();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        resource,
        error: describeError(cause),
      });
      return new Response("Sandbox terminal failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

// Binary messages are keystrokes. Text messages are resize requests.
function bridge(
  server: WebSocket,
  shell: ExecProcess,
  stdin: WritableStream<Uint8Array>,
  stdout: ReadableStream<Uint8Array>,
  abort: AbortController,
): void {
  const input = stdin.getWriter();
  let exited = false;
  const markExited = () => {
    exited = true;
  };
  shell.exitCode.then(markExited, markExited);
  // Aborting exec() sends SIGKILL to the shell; its background jobs keep running. Signalling a
  // shell that already exited records an internal error, so stop only a running one.
  const stop = () => {
    if (!exited) abort.abort();
  };

  // A listener that throws closes the socket without running "close", which would leave
  // the shell running. Neither listener throws.
  server.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      input.write(new Uint8Array(event.data)).catch(stop);
      return;
    }
    const size = parseSize(event.data);
    if (size !== undefined) shell.resize(size.cols, size.rows);
  });
  server.addEventListener("close", stop);
  server.addEventListener("error", stop);

  void (async () => {
    try {
      // PTY output passes through unchanged. The browser is the terminal emulator.
      for await (const chunk of stdout) server.send(chunk);
      server.close(1000, `Shell exited with code ${await shell.exitCode}`);
    } catch (cause) {
      if (abort.signal.aborted) return;
      console.error({ event: "terminal.output.failed", error: describeError(cause) });
      stop();
      server.close(1011, "Shell output failed");
    }
  })();
}

function parseSize(message: string): z.infer<typeof TerminalSize> | undefined {
  try {
    const size = TerminalSize.safeParse(JSON.parse(message));
    return size.success ? size.data : undefined;
  } catch {
    return undefined;
  }
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) throw new Error("Container attachment is unavailable");
  return container;
}

// Structured logs drop an Error's message and stack because they are not enumerable.
function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}
