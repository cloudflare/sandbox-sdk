import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { terminalPage } from "./page.js";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// tmux session names cannot contain "." or ":".
const SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
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

  async listSessions(): Promise<{ name: string; attachedClients: number }[]> {
    if (!this.#container.running) return [];
    const result = await this.#tmux(["list-sessions", "-F", "#{session_name} #{session_attached}"]);
    // tmux exits 1 when no session exists, because its server is not running.
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [name, attachedClients] = line.split(" ");
        return { name, attachedClients: Number(attachedClients) };
      });
  }

  // Ends the session's shell and every process in it. Attached terminals close.
  async killSession(session: string): Promise<boolean> {
    if (!this.#container.running) return false;
    // "=" matches the name exactly instead of as a prefix.
    const result = await this.#tmux(["kill-session", "-t", `=${session}`]);
    return result.exitCode === 0;
  }

  async #tmux(args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const process = await this.#container.exec(["tmux", ...args]);
    const output = await process.output();
    return { exitCode: output.exitCode, stdout: new TextDecoder().decode(output.stdout) };
  }

  // Each WebSocket attaches a tmux client to a named session. The session, its shell, and
  // its processes outlive the WebSocket, so a new WebSocket can attach again.
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

    const session = url.searchParams.get("session") ?? "main";
    if (!SESSION_NAME_PATTERN.test(session)) {
      return new Response(
        "session must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandboxName = url.searchParams.get("sandbox") ?? "";
    this.#ensureExecution(sandboxName);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const abort = new AbortController();
    // -A attaches to the session if it exists, and creates it otherwise.
    const tmuxClient = await this.#container.exec(["tmux", "new-session", "-A", "-s", session], {
      pty: size.data,
      env: { TERM: "xterm-256color" },
      cwd: WORKSPACE_DIRECTORY,
      signal: abort.signal,
    });
    if (tmuxClient.stdin === null || tmuxClient.stdout === null) {
      abort.abort();
      throw new Error("exec() did not return the terminal streams");
    }

    const [client, server] = Object.values(new WebSocketPair());
    // Binary messages arrive as Blob unless the socket asks for ArrayBuffer.
    server.binaryType = "arraybuffer";
    // A hibernating WebSocket would discard the tmux client's process handle.
    // An accepted one keeps this instance, and the handle, in memory.
    server.accept();
    bridge(server, tmuxClient, tmuxClient.stdin, tmuxClient.stdout, abort);
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
    const match = /^\/sandboxes\/([^/]+)\/(terminal|sessions|execution)?(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    if (match === null) return new Response("Not found", { status: 404 });

    const [, sandboxName, resource, session] = match;
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    if (session !== undefined && (resource !== "sessions" || !SESSION_NAME_PATTERN.test(session))) {
      return new Response("Not found", { status: 404 });
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
      if (resource === "sessions" && session === undefined && request.method === "GET") {
        return Response.json(await sandbox.listSessions());
      }
      if (resource === "sessions" && session !== undefined && request.method === "DELETE") {
        return (await sandbox.killSession(session))
          ? new Response(null, { status: 204 })
          : new Response("Session not found", { status: 404 });
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
  client: ExecProcess,
  stdin: WritableStream<Uint8Array>,
  stdout: ReadableStream<Uint8Array>,
  abort: AbortController,
): void {
  const input = stdin.getWriter();
  let exited = false;
  const markExited = () => {
    exited = true;
  };
  client.exitCode.then(markExited, markExited);
  // Aborting exec() sends SIGKILL to the tmux client. The session keeps running for the next
  // WebSocket. Signalling a client that already exited records an internal error, so stop
  // only a running one.
  const stop = () => {
    if (!exited) abort.abort();
  };

  // A listener that throws closes the socket without running "close", which would leave
  // the client running. Neither listener throws.
  server.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      input.write(new Uint8Array(event.data)).catch(stop);
      return;
    }
    const size = parseSize(event.data);
    if (size !== undefined) client.resize(size.cols, size.rows);
  });
  server.addEventListener("close", stop);
  server.addEventListener("error", stop);

  void (async () => {
    try {
      // PTY output passes through unchanged. The browser is the terminal emulator.
      for await (const chunk of stdout) server.send(chunk);
      // The tmux client exits when its session ends or it detaches. Either way, do not reconnect.
      server.close(1000, `Terminal closed with code ${await client.exitCode}`);
    } catch (cause) {
      if (abort.signal.aborted) return;
      console.error({ event: "terminal.output.failed", error: describeError(cause) });
      stop();
      server.close(1011, "Terminal output failed");
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
