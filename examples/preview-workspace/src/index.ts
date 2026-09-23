import { Files, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_DIRECTORY = "/workspace/app";
const SOURCE_PATH = `${APP_DIRECTORY}/src/main.js`;
const DEV_SERVER_LOG_PATH = "/tmp/dev-server.log";
const DEV_SERVER_PORT = 5173;
const DEV_SERVER_START_TIMEOUT_MS = 60_000;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

// Replace this loop with the native getTcpPort() readiness option when it ships.
const NOT_LISTENING_PREFIXES = [
  "The container is not listening in the TCP address ",
  "Container is not listening to port ",
];

interface Env {
  SANDBOX: DurableObjectNamespace<PreviewSandbox>;
  PREVIEW_DOMAIN: string;
}

type PreviewResult =
  | { status: "ready"; url: string }
  | { status: "exited"; exitCode: number; log: string }
  | { status: "timed-out"; log: string };

export class PreviewSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  #starting: Promise<PreviewResult> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async writeSource(source: ReadableStream<Uint8Array>, sandboxName: string): Promise<void> {
    await this.#ensureExecution(sandboxName);
    await this.#files.writeFile(SOURCE_PATH, source);
  }

  startPreview(sandboxName: string): Promise<PreviewResult> {
    if (this.#starting !== undefined) return this.#starting;
    const starting = this.#startPreview(sandboxName).finally(() => {
      if (this.#starting === starting) this.#starting = undefined;
    });
    this.#starting = starting;
    return starting;
  }

  async resetExecution(): Promise<void> {
    // A start in flight belongs to the Container being destroyed.
    this.#starting = undefined;
    if (this.#container.running) await this.#container.destroy();
  }

  // Preview requests never start the Container or the dev server.
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.protocol = "http:";
    try {
      return await this.#container.getTcpPort(DEV_SERVER_PORT).fetch(new Request(url, request));
    } catch (cause) {
      if (!isNotListening(cause)) console.error({ event: "preview.forward.failed", cause });
      return new Response("Preview is not running", { status: 503 });
    }
  }

  async #ensureExecution(sandboxName: string): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "standard-1",
      enableInternet: false,
      labels: { example: "preview-workspace", sandbox: sandboxName },
    });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  async #startPreview(sandboxName: string): Promise<PreviewResult> {
    await this.#ensureExecution(sandboxName);
    const previewHost = `${sandboxName}.${this.env.PREVIEW_DOMAIN}`;
    const ready: PreviewResult = { status: "ready", url: `https://${previewHost}/` };
    if (await this.#devServerAnswers()) return ready;

    // Piped output would kill the server after this request ends, so write a log file.
    const server = await this.#container.exec(
      ["/bin/sh", "-c", `exec ./node_modules/.bin/vite >${DEV_SERVER_LOG_PATH} 2>&1`],
      {
        cwd: APP_DIRECTORY,
        env: { PREVIEW_HOST: previewHost },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const exited = new AbortController();
    let exitCode: number | undefined;
    server.exitCode.then(
      (code) => {
        exitCode = code;
        exited.abort();
      },
      (cause: unknown) => exited.abort(cause),
    );
    const signal = AbortSignal.any([
      exited.signal,
      AbortSignal.timeout(DEV_SERVER_START_TIMEOUT_MS),
    ]);

    while (!signal.aborted) {
      try {
        if (await this.#devServerAnswers(signal)) return ready;
        await scheduler.wait(100, { signal });
      } catch (cause) {
        if (!signal.aborted) throw cause;
      }
    }
    if (exitCode !== undefined) {
      return { status: "exited", exitCode, log: await this.#devServerLog() };
    }
    if (exited.signal.aborted) throw exited.signal.reason;
    server.kill();
    return { status: "timed-out", log: await this.#devServerLog() };
  }

  async #devServerAnswers(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.#container
        .getTcpPort(DEV_SERVER_PORT)
        .fetch("http://localhost/", { signal });
      await response.body?.cancel();
      return true;
    } catch (cause) {
      if (isNotListening(cause)) return false;
      throw cause;
    }
  }

  async #devServerLog(): Promise<string> {
    return (await this.#files.readFile(DEV_SERVER_LOG_PATH)).text();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const previewSuffix = `.${env.PREVIEW_DOMAIN}`;
    if (url.hostname.endsWith(previewSuffix)) {
      const sandboxName = url.hostname.slice(0, -previewSuffix.length);
      if (!SANDBOX_NAME_PATTERN.test(sandboxName))
        return new Response("Not found", { status: 404 });
      return env.SANDBOX.getByName(sandboxName).fetch(request);
    }

    const match = /^\/sandboxes\/([^/]+)\/(source|preview|execution)$/.exec(url.pathname);
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
      if (resource === "preview" && request.method === "POST") {
        const result = await sandbox.startPreview(sandboxName);
        return Response.json(result, { status: result.status === "ready" ? 200 : 502 });
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

function isNotListening(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    NOT_LISTENING_PREFIXES.some((prefix) => cause.message.startsWith(prefix))
  );
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) throw new Error("Container attachment is unavailable");
  return container;
}

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    if (cause.code === "ENOENT") return new Response("Workspace file not found", { status: 404 });
    return new Response("Workspace file operation failed", { status: 500 });
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox file protocol failed", { status: 500 });
  }
  return new Response("Sandbox request failed", { status: 500 });
}
