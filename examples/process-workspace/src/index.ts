import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { type LogStream, type ProcessInfo, Processes } from "./processes.js";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROCESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
// Requests keep a Container awake; a running process does not. Check well within the timeout.
const PROCESS_CHECK_INTERVAL_MS = 60 * 1_000;
const MAX_WAIT_MS = 5 * 60 * 1_000;

const StartRequest = z.object({
  id: z.string().regex(PROCESS_ID_PATTERN).optional(),
  command: z.array(z.string()).min(1),
  cwd: z.string().startsWith("/").default("/workspace"),
  env: z.record(z.string(), z.string()).default({}),
});
const WaitRequest = z.object({ timeoutMs: z.int().min(1).max(MAX_WAIT_MS).default(30_000) });
const WaitForLogRequest = WaitRequest.extend({ pattern: z.string().min(1) });
const Signal = z.enum(["TERM", "INT", "HUP", "KILL"]).default("TERM");
const Stream = z.enum(["stdout", "stderr"]).default("stdout");

interface Env {
  SANDBOX: DurableObjectNamespace<ProcessSandbox>;
}

export class ProcessSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #processes: Processes;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
    this.#processes = new Processes(this.#container, this.#files);
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async startProcess(
    sandboxName: string,
    request: z.infer<typeof StartRequest>,
  ): Promise<ProcessInfo | undefined> {
    await this.#ensureExecution(sandboxName);
    const process = await this.#processes.start({
      ...request,
      id: request.id ?? crypto.randomUUID(),
    });
    if (process !== undefined)
      await this.ctx.storage.setAlarm(Date.now() + PROCESS_CHECK_INTERVAL_MS);
    return process;
  }

  // A stopped Container has no processes. These calls never start one.
  async listProcesses(): Promise<ProcessInfo[]> {
    return this.#container.running ? this.#processes.list() : [];
  }

  async getProcess(id: string): Promise<ProcessInfo | undefined> {
    return this.#container.running ? this.#processes.get(id) : undefined;
  }

  async killProcess(id: string, signal: string): Promise<boolean> {
    return this.#container.running ? this.#processes.kill(id, signal) : false;
  }

  async killAllProcesses(signal: string): Promise<string[]> {
    return this.#container.running ? this.#processes.killAll(signal) : [];
  }

  async cleanupProcesses(): Promise<string[]> {
    if (!this.#container.running) return [];
    const removed = await this.#processes.cleanup();
    for (const id of removed) this.#forgetReports(`reported:${id}:`);
    return removed;
  }

  async readLog(id: string, stream: LogStream, follow: boolean): Promise<Response | undefined> {
    if (!this.#container.running) return undefined;
    if (follow) return this.#processes.followLog(id, stream);
    return this.#processes.readLog(id, stream);
  }

  async waitForLog(id: string, request: z.infer<typeof WaitForLogRequest>) {
    if (!this.#container.running) return undefined;
    return this.#processes.waitForLog(id, request.pattern, request.timeoutMs);
  }

  async waitForExit(id: string, request: z.infer<typeof WaitRequest>) {
    if (!this.#container.running) return undefined;
    return this.#processes.waitForExit(id, request.timeoutMs);
  }

  // Each check is a request to the Container, so it stays awake while any process runs.
  // This is also where the app learns that a process exited, in place of an onExit callback.
  override async alarm(): Promise<void> {
    if (!this.#container.running) return;
    let running = false;
    for (const process of await this.#processes.list()) {
      if (process.status.state === "running" || process.status.state === "starting") {
        running = true;
      } else if (
        this.ctx.storage.kv.get(`reported:${process.id}:${process.startedAt}`) === undefined
      ) {
        console.log({ event: "process.ended", id: process.id, status: process.status });
        this.ctx.storage.kv.put(`reported:${process.id}:${process.startedAt}`, true);
      }
    }
    if (running) await this.ctx.storage.setAlarm(Date.now() + PROCESS_CHECK_INTERVAL_MS);
  }

  async resetExecution(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.#forgetReports("reported:");
    if (this.#container.running) await this.#container.destroy();
  }

  #forgetReports(prefix: string): void {
    const keys = [...this.ctx.storage.kv.list({ prefix })].map(([key]) => key);
    for (const key of keys) this.ctx.storage.kv.delete(key);
  }

  async #ensureExecution(sandboxName: string): Promise<void> {
    if (this.#container.running) return;
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "lite",
      enableInternet: false,
      labels: { example: "process-workspace", sandbox: sandboxName },
    });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match =
      /^\/sandboxes\/([^/]+)\/(processes|execution)(?:\/([^/]+))?(?:\/(logs|wait-for-log|wait))?$/.exec(
        url.pathname,
      );
    if (match === null) return new Response("Not found", { status: 404 });
    const [, sandboxName, resource, id, action] = match;
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }
    if (id !== undefined && id !== "cleanup" && !PROCESS_ID_PATTERN.test(id)) {
      return new Response("Process not found", { status: 404 });
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      return await route(sandbox, sandboxName, request, url, resource, id, action);
    } catch (cause) {
      if (cause instanceof z.ZodError) return new Response(z.prettifyError(cause), { status: 400 });
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        path: url.pathname,
        error: describeError(cause),
      });
      if (SandboxFileError.is(cause) && cause.code === "ENOENT") {
        return new Response("Process not found", { status: 404 });
      }
      return new Response("Sandbox request failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  sandbox: DurableObjectStub<ProcessSandbox>,
  sandboxName: string,
  request: Request,
  url: URL,
  resource: string,
  id: string | undefined,
  action: string | undefined,
): Promise<Response> {
  const method = request.method;
  if (resource === "execution" && id === undefined && method === "DELETE") {
    await sandbox.resetExecution();
    return new Response(null, { status: 204 });
  }
  if (resource !== "processes") return new Response("Not found", { status: 404 });
  const signal = Signal.parse(url.searchParams.get("signal") ?? undefined);

  if (id === undefined) {
    if (method === "POST") {
      const process = await sandbox.startProcess(
        sandboxName,
        StartRequest.parse(await request.json()),
      );
      if (process === undefined) return new Response("Process ID is in use", { status: 409 });
      return Response.json(process, { status: 201 });
    }
    if (method === "GET") return Response.json(await sandbox.listProcesses());
    if (method === "DELETE")
      return Response.json({ killed: await sandbox.killAllProcesses(signal) });
    return new Response("Method not allowed", { status: 405 });
  }
  if (id === "cleanup" && action === undefined && method === "POST") {
    return Response.json({ removed: await sandbox.cleanupProcesses() });
  }

  if (action === undefined && method === "GET") {
    const process = await sandbox.getProcess(id);
    return process === undefined
      ? new Response("Process not found", { status: 404 })
      : Response.json(process);
  }
  if (action === undefined && method === "DELETE") {
    const killed = await sandbox.killProcess(id, signal);
    return killed
      ? new Response(null, { status: 202 })
      : new Response("Process is not running", { status: 409 });
  }
  if (action === "logs" && method === "GET") {
    const stream = Stream.parse(url.searchParams.get("stream") ?? undefined);
    const log = await sandbox.readLog(id, stream, url.searchParams.has("follow"));
    return log ?? new Response("Process not found", { status: 404 });
  }
  if (action === "wait-for-log" && method === "POST") {
    const result = await sandbox.waitForLog(id, WaitForLogRequest.parse(await request.json()));
    return result === undefined
      ? new Response("Process not found", { status: 404 })
      : Response.json(result);
  }
  if (action === "wait" && method === "POST") {
    const result = await sandbox.waitForExit(id, WaitRequest.parse(await request.json()));
    return result === undefined
      ? new Response("Process not found", { status: 404 })
      : Response.json(result);
  }
  return new Response("Method not allowed", { status: 405 });
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
