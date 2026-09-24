// Example code, not part of @cloudflare/sandbox. It owns its deadlines and URL format.
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Preview hostnames use 0.12's format: <port>-<sandbox name>-<token>.<PREVIEW_DOMAIN>.
const PREVIEW_LABEL_PATTERN = /^(\d{1,5})-([a-z0-9][a-z0-9-]*)-([a-z0-9_]{1,16})$/;
// 32 letters, so each random byte maps to one without bias.
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_LENGTH = 16;
const DNS_LABEL_MAX_LENGTH = 63;
const SERVER_DIRECTORY = "/var/lib/servers";
const TUNNEL_DIRECTORY = "/var/lib/tunnels";
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const SERVER_START_TIMEOUT_MS = 60_000;
const TUNNEL_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

const Port = z.int().min(1).max(65_535);
const ServerRequest = z.object({
  port: Port,
  command: z.array(z.string()).min(1),
  cwd: z.string().startsWith("/").default("/workspace"),
});
const ExposeRequest = z.object({
  port: Port,
  name: z.string().max(200).optional(),
  // 0.12 accepted the same custom tokens. Short tokens are easier to guess.
  token: z
    .string()
    .regex(/^[a-z0-9_]{1,16}$/, "use 1-16 lowercase letters, digits, or underscores")
    .optional(),
});
const TunnelRequest = z.object({ port: Port });

// Replace this loop with the native getTcpPort() readiness option when it ships.
const NOT_LISTENING_PREFIXES = [
  "The container is not listening in the TCP address ",
  "Container is not listening to port ",
];

// Prints "ready <url>" once cloudflared has a URL and a connection, "exited" if it
// stopped first, and nothing while it is still connecting.
const TUNNEL_STATUS_SCRIPT = `
dir=$1
url=$(grep -o -m1 -E 'https://[a-z0-9-]+\\.trycloudflare\\.com' "$dir/log" 2>/dev/null)
if [ -n "$url" ] && grep -q 'Registered tunnel connection' "$dir/log"; then
  echo "ready $url"
elif ! kill -0 "$(cat "$dir/pid" 2>/dev/null)" 2>/dev/null; then
  echo exited
fi
`;

// Prints "<port> <url>" for each tunnel whose cloudflared process is still running.
const TUNNEL_LIST_SCRIPT = `
for dir in ${TUNNEL_DIRECTORY}/*/; do
  [ -f "$dir/url" ] || continue
  kill -0 "$(cat "$dir/pid")" 2>/dev/null || continue
  echo "$(basename "$dir") $(cat "$dir/url")"
done
`;

interface Env {
  SANDBOX: DurableObjectNamespace<ShareSandbox>;
  PREVIEW_DOMAIN: string;
}

type ServerResult =
  | { state: "ready"; port: number }
  | { state: "exited"; port: number; exitCode: number; log: string }
  | { state: "timed-out"; port: number; log: string };

interface ExposedPort {
  port: number;
  name: string | null;
  url: string;
  createdAt: string;
}

interface StoredPort {
  name: string | null;
  token: string;
  createdAt: string;
}

type TunnelResult =
  | { state: "ready"; port: number; url: string }
  | { state: "exited"; port: number; log: string }
  | { state: "timed-out"; port: number; log: string };

export class ShareSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;

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

  // Starts a command in the background and waits until its port answers HTTP.
  async startServer(
    sandboxName: string,
    request: z.infer<typeof ServerRequest>,
  ): Promise<ServerResult> {
    const { port } = request;
    await this.#ensureExecution(sandboxName);
    if (await this.#portAnswers(port)) return { state: "ready", port };

    const logPath = `${SERVER_DIRECTORY}/${port}.log`;
    // Piped output would kill the server after this request ends, so write a log file.
    const server = await this.#container.exec(
      [
        "/bin/sh",
        "-c",
        'log=$1; shift; mkdir -p "${log%/*}" && exec "$@" >"$log" 2>&1',
        "server",
        logPath,
        ...request.command,
      ],
      { cwd: request.cwd, stdout: "ignore", stderr: "ignore" },
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
    const signal = AbortSignal.any([exited.signal, AbortSignal.timeout(SERVER_START_TIMEOUT_MS)]);

    while (!signal.aborted) {
      try {
        if (await this.#portAnswers(port, signal)) return { state: "ready", port };
        await scheduler.wait(POLL_INTERVAL_MS, { signal });
      } catch (cause) {
        if (!signal.aborted) throw cause;
      }
    }
    if (exitCode !== undefined) {
      return { state: "exited", port, exitCode, log: await this.#readLog(logPath) };
    }
    if (exited.signal.aborted) throw exited.signal.reason;
    server.kill();
    return { state: "timed-out", port, log: await this.#readLog(logPath) };
  }

  // Exposing a port does not start the Container. Requests return 503 until a server answers.
  async exposePort(
    sandboxName: string,
    request: z.infer<typeof ExposeRequest>,
  ): Promise<ExposedPort> {
    const key = portKey(request.port);
    const existing = this.ctx.storage.kv.get<StoredPort>(key);
    const stored: StoredPort = {
      name: request.name ?? existing?.name ?? null,
      token: request.token ?? existing?.token ?? randomToken(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.ctx.storage.kv.put(key, stored);
    return this.#describePort(sandboxName, request.port, stored);
  }

  listPorts(sandboxName: string): ExposedPort[] {
    return [...this.ctx.storage.kv.list<StoredPort>({ prefix: "port:" })].map(([key, stored]) =>
      this.#describePort(sandboxName, Number(key.slice("port:".length)), stored),
    );
  }

  unexposePort(port: number): boolean {
    return this.ctx.storage.kv.delete(portKey(port));
  }

  // Starts a quick tunnel: a public trycloudflare.com URL that reaches the port directly.
  async openTunnel(sandboxName: string, port: number): Promise<TunnelResult> {
    await this.#ensureExecution(sandboxName);
    const existing = (await this.listTunnels()).find((tunnel) => tunnel.port === port);
    if (existing !== undefined) return { state: "ready", ...existing };

    const dir = `${TUNNEL_DIRECTORY}/${port}`;
    await this.#container.exec(
      [
        "/bin/sh",
        "-c",
        'dir=$1; port=$2; rm -rf "$dir"; mkdir -p "$dir"; echo "$$" >"$dir/pid"; ' +
          'exec cloudflared tunnel --no-autoupdate --url "http://localhost:$port" >"$dir/log" 2>&1',
        "tunnel",
        dir,
        String(port),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    const deadline = Date.now() + TUNNEL_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = (
        await this.#run(["/bin/sh", "-c", TUNNEL_STATUS_SCRIPT, "status", dir])
      ).trim();
      if (status.startsWith("ready ")) {
        const url = status.slice("ready ".length);
        await this.#files.writeFile(`${dir}/url`, url);
        return { state: "ready", port, url };
      }
      if (status === "exited")
        return { state: "exited", port, log: await this.#readLog(`${dir}/log`) };
      await scheduler.wait(POLL_INTERVAL_MS);
    }
    const log = await this.#readLog(`${dir}/log`);
    await this.#stopTunnel(dir);
    return { state: "timed-out", port, log };
  }

  async listTunnels(): Promise<{ port: number; url: string }[]> {
    if (!this.#container.running) return [];
    const output = await this.#run(["/bin/sh", "-c", TUNNEL_LIST_SCRIPT]);
    return output
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [port, url] = line.split(" ");
        return { port: Number(port), url };
      });
  }

  async closeTunnel(port: number): Promise<boolean> {
    if (!(await this.listTunnels()).some((tunnel) => tunnel.port === port)) return false;
    await this.#stopTunnel(`${TUNNEL_DIRECTORY}/${port}`);
    return true;
  }

  async resetExecution(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  // Preview requests. They never start the Container or a server.
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const label = url.hostname.slice(0, -`.${this.env.PREVIEW_DOMAIN}`.length);
    const match = PREVIEW_LABEL_PATTERN.exec(label);
    if (match === null) return notFound();
    const port = Number(match[1]);
    const stored = this.ctx.storage.kv.get<StoredPort>(portKey(port));
    if (stored === undefined || !tokensMatch(stored.token, match[3])) return notFound();
    if (!this.#container.running) return new Response("Sandbox is not running", { status: 503 });

    url.protocol = "http:";
    try {
      return await this.#container.getTcpPort(port).fetch(new Request(url, request));
    } catch (cause) {
      if (!isNotListening(cause)) {
        console.error({ event: "preview.forward.failed", port, error: describeError(cause) });
      }
      return new Response("Nothing is listening on this port", { status: 503 });
    }
  }

  #describePort(sandboxName: string, port: number, stored: StoredPort): ExposedPort {
    const host = `${previewLabel(port, sandboxName, stored.token)}.${this.env.PREVIEW_DOMAIN}`;
    return { port, name: stored.name, url: `https://${host}/`, createdAt: stored.createdAt };
  }

  async #ensureExecution(sandboxName: string): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "standard-1",
      // cloudflared needs Internet access to reach Cloudflare. Without it, tunnels fail to start.
      enableInternet: true,
      labels: { example: "share-workspace", sandbox: sandboxName },
    });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  async #portAnswers(port: number, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.#container
        .getTcpPort(port)
        .fetch("http://localhost/", { signal });
      await response.body?.cancel();
      return true;
    } catch (cause) {
      if (isNotListening(cause)) return false;
      throw cause;
    }
  }

  async #stopTunnel(dir: string): Promise<void> {
    await this.#run([
      "/bin/sh",
      "-c",
      'kill -TERM "$(cat "$1/pid")" 2>/dev/null; rm -rf -- "$1"',
      "stop",
      dir,
    ]);
  }

  async #run(command: string[]): Promise<string> {
    const child = await this.#container.exec(command, { stderr: "ignore" });
    const output = await child.output();
    return new TextDecoder().decode(output.stdout);
  }

  async #readLog(path: string): Promise<string> {
    return this.#run(["tail", "-c", "65536", path]);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const previewSuffix = `.${env.PREVIEW_DOMAIN}`;
    if (url.hostname.endsWith(previewSuffix)) {
      const match = PREVIEW_LABEL_PATTERN.exec(url.hostname.slice(0, -previewSuffix.length));
      if (match === null || !SANDBOX_NAME_PATTERN.test(match[2])) return notFound();
      return env.SANDBOX.getByName(match[2]).fetch(request);
    }

    const route = /^\/sandboxes\/([^/]+)\/(servers|ports|tunnels|execution)(?:\/(\d{1,5}))?$/.exec(
      url.pathname,
    );
    if (route === null) return notFound();
    const [, sandboxName, resource, portText] = route;
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      const method = request.method;
      if (resource === "execution") {
        if (method !== "DELETE" || portText !== undefined) return methodNotAllowed();
        await sandbox.resetExecution();
        return new Response(null, { status: 204 });
      }
      if (portText === undefined) {
        if (method === "GET" && resource === "ports") {
          return Response.json(await sandbox.listPorts(sandboxName));
        }
        if (method === "GET" && resource === "tunnels") {
          return Response.json(await sandbox.listTunnels());
        }
        if (method !== "POST") return methodNotAllowed();
        const body = await request.json();
        if (resource === "servers") {
          const result = await sandbox.startServer(sandboxName, ServerRequest.parse(body));
          return Response.json(result, { status: result.state === "ready" ? 200 : 502 });
        }
        if (resource === "ports") {
          const expose = ExposeRequest.parse(body);
          // A stored custom token can only be shorter than a generated one.
          const token = expose.token ?? "x".repeat(TOKEN_LENGTH);
          if (previewLabel(expose.port, sandboxName, token).length > DNS_LABEL_MAX_LENGTH) {
            throw new RequestError(
              `The preview hostname label would exceed ${DNS_LABEL_MAX_LENGTH} characters. Use a shorter sandbox name or token.`,
            );
          }
          return Response.json(await sandbox.exposePort(sandboxName, expose), {
            status: 201,
          });
        }
        const { port } = TunnelRequest.parse(body);
        const result = await sandbox.openTunnel(sandboxName, port);
        return Response.json(result, { status: result.state === "ready" ? 201 : 502 });
      }
      const port = Port.parse(Number(portText));
      if (method !== "DELETE" || resource === "servers") return methodNotAllowed();
      const removed =
        resource === "ports" ? await sandbox.unexposePort(port) : await sandbox.closeTunnel(port);
      return removed ? new Response(null, { status: 204 }) : notFound();
    } catch (cause) {
      if (cause instanceof RequestError) return new Response(cause.message, { status: 400 });
      if (cause instanceof z.ZodError) return new Response(z.prettifyError(cause), { status: 400 });
      if (cause instanceof SyntaxError) return new Response("Invalid JSON body", { status: 400 });
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        resource,
        error: describeError(cause),
      });
      return new Response("Sandbox request failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

class RequestError extends Error {
  override name = "RequestError";
}

function portKey(port: number): string {
  return `port:${port}`;
}

function previewLabel(port: number, sandboxName: string, token: string): string {
  return `${port}-${sandboxName}-${token}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  return Array.from(bytes, (byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join("");
}

// Compares every character, so the time taken does not reveal how much of a token matched.
function tokensMatch(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed", { status: 405 });
}

// Structured logs drop an Error's message and stack because they are not enumerable.
function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}

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
