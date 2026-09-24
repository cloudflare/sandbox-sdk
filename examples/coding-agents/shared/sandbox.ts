import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";

import type { Outbound } from "./outbound";

const REPOSITORY_DIRECTORY = "/workspace/repo";
const TASK_DIRECTORY = "/workspace/task";
const EVENTS_PATH = `${TASK_DIRECTORY}/events.jsonl`;
const STDERR_PATH = `${TASK_DIRECTORY}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIRECTORY}/exit-code`;
const PID_PATH = `${TASK_DIRECTORY}/pid`;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
// Requests keep a Container awake; a running process does not. Check the task well within the timeout.
const TASK_CHECK_INTERVAL_MS = 60 * 1_000;
const TASK_KEY = "task";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// exec() does not inherit start() env. Pass these on every command that makes HTTPS requests.
const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
};

// Output goes to files so the agent keeps running after the request that started it ends.
const TASK_SCRIPT = `"$@" >${EVENTS_PATH} 2>${STDERR_PATH}
printf '%s\\n' "$?" >${EXIT_CODE_PATH}.tmp && mv ${EXIT_CODE_PATH}.tmp ${EXIT_CODE_PATH}`;

export interface CodingAgentEnv {
  SANDBOX: DurableObjectNamespace<CodingAgentSandbox>;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_TOKEN: string;
  // Optional JSON attached to gateway logs, for example {"project": "my-app"}.
  AI_GATEWAY_METADATA?: string;
  MODEL: string;
  GITHUB_TOKEN?: string;
}

interface CodingAgentState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly Outbound: LoopbackForExport<typeof Outbound> };
}

export interface AgentCommand {
  argv: string[];
  env: Record<string, string>;
}

export type TaskOutcome =
  | { state: "succeeded"; result: string }
  | { state: "failed"; error: string };

export type TaskStatus = { state: "none" } | { state: "running" } | { state: "lost" } | TaskOutcome;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Clones a repository, runs one agent task at a time in the background, and reports its outcome.
// Each agent supplies its command and how to read its outcome.
export abstract class CodingAgentSandbox extends DurableObject<CodingAgentEnv> {
  protected abstract readonly agent: string;
  // Task files live outside the repository so they stay out of the diff. The directory is emptied before each task.
  protected readonly taskDirectory = TASK_DIRECTORY;
  readonly #container: Container;
  readonly #files: Files;
  readonly #outbound: Fetcher;

  constructor(ctx: CodingAgentState, env: CodingAgentEnv) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
    this.#outbound = ctx.exports.Outbound({});
    // Each Durable Object instance must set its own timeout; it is not inherited.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  // The agent's command line and environment. The task runs in the repository directory.
  protected abstract command(prompt: string): AgentCommand;

  // Called once the agent has exited. Read its events, files, or exit code.
  protected abstract outcome(exitCode: number): Promise<TaskOutcome>;

  async cloneRepository(
    sandboxName: string,
    repository: string,
    ref: string | undefined,
  ): Promise<CommandResult> {
    await this.#ensureExecution(sandboxName);
    const branch = ref === undefined ? [] : ["--branch", ref];
    return this.#run(
      ["git", "clone", "--depth", "1", ...branch, "--", repository, REPOSITORY_DIRECTORY],
      "/workspace",
      TRUST_ENV,
    );
  }

  startTask(sandboxName: string, prompt: string): Promise<"started" | "busy"> {
    // Block other requests so two starts cannot both see an idle task.
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.#ensureExecution(sandboxName);
      if ((await this.#taskStatus()).state === "running") return "busy";
      await this.#files.remove(TASK_DIRECTORY, { recursive: true, force: true });
      await this.#files.mkdir(TASK_DIRECTORY);
      const { argv, env } = this.command(prompt);
      const task = await this.#container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", ...argv], {
        cwd: REPOSITORY_DIRECTORY,
        env: { ...TRUST_ENV, ...env },
        stdout: "ignore",
        stderr: "ignore",
      });
      await this.#files.writeFile(PID_PATH, String(task.pid));
      this.ctx.storage.kv.put(TASK_KEY, "started");
      await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
      return "started";
    });
  }

  // Each check is a request to the Container, so it stays awake while the agent runs.
  async alarm(): Promise<void> {
    if (!this.#container.running) return;
    if ((await this.#taskStatus()).state === "running") {
      await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
      return;
    }
    this.ctx.storage.kv.delete(TASK_KEY);
  }

  async readTask(): Promise<TaskStatus> {
    if (!this.#container.running) {
      // A recorded task means the Container stopped before the agent finished.
      return this.ctx.storage.kv.get(TASK_KEY) === undefined
        ? { state: "none" }
        : { state: "lost" };
    }
    return this.#taskStatus();
  }

  async readEvents(): Promise<Response> {
    return this.#files.readFile(EVENTS_PATH);
  }

  async readDiff(sandboxName: string): Promise<CommandResult> {
    await this.#ensureExecution(sandboxName);
    // Intent-to-add makes new files show up in the diff.
    return this.#run(
      ["/bin/sh", "-c", "git add --intent-to-add . && git diff"],
      REPOSITORY_DIRECTORY,
      {},
    );
  }

  async resetExecution(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete(TASK_KEY);
    if (this.#container.running) await this.#container.destroy();
  }

  // The agent writes one JSON event per line. Yields the events that match the schema.
  protected async *events<Event>(schema: z.ZodType<Event>): AsyncGenerator<Event> {
    for await (const line of readLines((await this.#files.readFile(EVENTS_PATH)).body)) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = schema.safeParse(event);
      if (parsed.success) yield parsed.data;
    }
  }

  protected readTaskFile(path: string): Promise<string | undefined> {
    return this.#readOptionalText(path);
  }

  protected async exitFailure(exitCode: number): Promise<TaskOutcome> {
    const stderr = (await this.#readOptionalText(STDERR_PATH)) ?? "";
    return {
      state: "failed",
      error: `${this.agent} exited with ${exitCode}: ${stderr.slice(-2_000)}`,
    };
  }

  async #ensureExecution(sandboxName: string): Promise<void> {
    if (this.#container.running) return;
    // A new Container has a fresh disk, so any earlier task is gone.
    this.ctx.storage.kv.delete(TASK_KEY);
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "standard-1",
      enableInternet: false,
      labels: { example: `coding-agent-${this.agent}`, sandbox: sandboxName },
    });
    // Intercepts last for this Container run, so install them once per start.
    await this.#container.interceptAllOutboundHttp(this.#outbound);
    await this.#container.interceptOutboundHttps("*", this.#outbound);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  async #taskStatus(): Promise<TaskStatus> {
    const exitCode = await this.#readOptionalText(EXIT_CODE_PATH);
    if (exitCode !== undefined) return this.outcome(Number.parseInt(exitCode, 10));
    const pid = await this.#readOptionalText(PID_PATH);
    if (pid === undefined) return { state: "none" };
    // kill is a shell builtin; slim images have no kill binary.
    const probe = await this.#run(["/bin/sh", "-c", 'kill -0 "$1"', "probe", pid.trim()], "/", {});
    // The process ended without recording an exit code, for example after a kill.
    return probe.exitCode === 0 ? { state: "running" } : { state: "lost" };
  }

  async #readOptionalText(path: string): Promise<string | undefined> {
    try {
      return await (await this.#files.readFile(path)).text();
    } catch (cause) {
      if (SandboxFileError.is(cause) && cause.code === "ENOENT") return undefined;
      throw cause;
    }
  }

  async #run(command: string[], cwd: string, env: Record<string, string>): Promise<CommandResult> {
    const process = await this.#container.exec(command, { cwd, env });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }
}

async function* readLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    yield* lines;
  }
  buffered += decoder.decode();
  if (buffered !== "") yield buffered;
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (container === undefined) throw new Error("Container attachment is unavailable");
  return container;
}
