import { DurableObject } from "cloudflare:workers";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const SIGKILL = 9;

interface Env {
  SANDBOX: DurableObjectNamespace<LiveTerminalSandbox>;
  SANDBOX_IMAGE: string;
}

interface ResizeControl {
  type: "resize";
  cols: number;
  rows: number;
}

interface ResizeWireValue {
  type?: unknown;
  cols?: unknown;
  rows?: unknown;
}

export class LiveTerminalSandbox extends DurableObject<Env> {
  /** Starts one physical execution for this logical sandbox. */
  async start(sandboxName: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) return;
    container.start({
      image: this.env.SANDBOX_IMAGE,
      instance: "lite",
      enableInternet: false,
      labels: { example: "live-terminal", workspace: sandboxName },
    });
    await container.setInactivityTimeout(DEFAULT_INACTIVITY_TIMEOUT_MS);
  }

  /** Immediately destroys the current physical execution. */
  async destroy(): Promise<void> {
    const container = this.requireContainer();
    if (container.running) await container.destroy();
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.requireContainer();
    if (!container.running) return new Response("container is not running", { status: 409 });
    const url = new URL(request.url);
    if (url.pathname !== "/pty") return new Response("Not found", { status: 404 });
    return this.openPty(request, url);
  }

  private async openPty(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    let cols: number;
    let rows: number;
    try {
      cols = boundedInteger(url.searchParams.get("cols"), 80, 1, 500, "cols");
      rows = boundedInteger(url.searchParams.get("rows"), 24, 1, 500, "rows");
    } catch (cause) {
      return new Response(cause instanceof Error ? cause.message : "invalid PTY dimensions", {
        status: 400,
      });
    }

    const abort = new AbortController();
    const process = await this.requireContainer().exec(["/bin/sh"], {
      env: { TERM: "xterm-256color", PS1: "sandbox$ " },
      pty: { cols, rows },
      signal: abort.signal,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "combined",
    });
    if (!process.isPty || process.stdin === null || process.stdout === null) {
      process.kill(SIGKILL);
      throw new Error("native exec did not return the requested PTY streams");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    try {
      // A live ExecProcess cannot survive Durable Object hibernation. A standard
      // WebSocket keeps this object instance and one native handle together.
      server.accept();
      bridgePty(server, process, process.stdin, process.stdout, abort, cols, rows);
      return new Response(null, { status: 101, webSocket: client });
    } catch (cause) {
      abort.abort("PTY bridge setup failed");
      try {
        process.kill(SIGKILL);
      } catch (killCause) {
        console.error({ event: "pty.setup.kill.failed", cause: killCause, pid: process.pid });
      }
      server.close(1011, "PTY bridge setup failed");
      throw cause;
    }
  }

  private requireContainer(): Container {
    const container = this.ctx.container;
    if (container === undefined) throw new Error("Container attachment is unavailable");
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
    if (url.pathname === "/start" && request.method === "POST") {
      await sandbox.start(sandboxName);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/execution" && request.method === "DELETE") {
      await sandbox.destroy();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/pty") return await sandbox.fetch(request);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function bridgePty(
  server: WebSocket,
  process: ExecProcess,
  stdin: WritableStream,
  stdout: ReadableStream,
  abort: AbortController,
  cols: number,
  rows: number,
): void {
  const writer = stdin.getWriter();
  const reader = stdout.getReader();
  let input = Promise.resolve();
  let finished = false;

  const stop = (reason: string): void => {
    if (finished) return;
    finished = true;
    abort.abort(reason);
    try {
      process.kill(SIGKILL);
    } catch (cause) {
      console.error({ event: "pty.kill.failed", cause, pid: process.pid });
    }
    void writer.abort(reason).catch(() => undefined);
    void reader.cancel(reason).catch(() => undefined);
  };

  server.addEventListener("message", (event: MessageEvent<string | ArrayBuffer | Blob>) => {
    const data = event.data;
    if (!(data instanceof ArrayBuffer) && !(data instanceof Blob)) {
      try {
        const resize = parseResize(data);
        process.resize(resize.cols, resize.rows);
      } catch (cause) {
        server.send(
          JSON.stringify({
            type: "error",
            message: cause instanceof Error ? cause.message : "invalid control message",
          }),
        );
      }
      return;
    }
    input = input.then(async () => {
      const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
      await writer.write(new Uint8Array(buffer));
    });
    input.catch((cause) => {
      if (finished) return;
      console.error({ event: "pty.input.failed", cause, pid: process.pid });
      stop("PTY input failed");
      closePtyWithError(server, "PTY input failed");
    });
  });
  server.addEventListener("close", () => stop("WebSocket closed"));
  server.addEventListener("error", () => stop("WebSocket errored"));

  void (async () => {
    try {
      server.send(JSON.stringify({ type: "ready", pid: process.pid, cols, rows }));
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        server.send(chunk.value);
      }
      const exitCode = await process.exitCode;
      if (!finished) {
        finished = true;
        server.send(JSON.stringify({ type: "exit", exitCode }));
        server.close(1000, "PTY process exited");
      }
    } catch (cause) {
      if (!finished) {
        console.error({ event: "pty.output.failed", cause, pid: process.pid });
        stop("PTY output failed");
        closePtyWithError(server, "PTY output failed");
      }
    } finally {
      writer.releaseLock();
      reader.releaseLock();
    }
  })();
}

function closePtyWithError(server: WebSocket, message: string): void {
  try {
    server.send(JSON.stringify({ type: "error", message }));
  } catch {
    // The transport failure may itself prevent the terminal control from being sent.
  }
  try {
    server.close(1011, message);
  } catch {
    // The socket may already have transitioned to closed while the process was being stopped.
  }
}

function parseResize(message: string): ResizeControl {
  const parsed: unknown = JSON.parse(message);
  if (Object.prototype.toString.call(parsed) !== "[object Object]") {
    throw new TypeError("expected resize object");
  }
  // SAFETY: The object tag above establishes a non-null plain object. Every consumed property is
  // independently validated below before conversion to the ResizeControl domain type.
  const value = parsed as ResizeWireValue;
  if (value.type !== "resize") throw new TypeError("unknown control type");
  if (value.cols === undefined || value.rows === undefined) {
    throw new TypeError("resize needs cols and rows");
  }
  if (
    Object.prototype.toString.call(value.cols) !== "[object Number]" ||
    Object.prototype.toString.call(value.rows) !== "[object Number]"
  ) {
    throw new TypeError("resize cols and rows must be numbers");
  }
  const cols = boundedInteger(Number(value.cols), 0, 1, 500, "cols");
  const rows = boundedInteger(Number(value.rows), 0, 1, 500, "rows");
  return { type: "resize", cols, rows };
}

function boundedInteger(
  value: string | number | null,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const number = value === null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}
