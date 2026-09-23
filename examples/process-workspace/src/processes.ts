import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { z } from "zod";

// Each process gets a directory: process.json, pid, stdout.log, stderr.log, and exit-code once it ends.
// The directory lives on the Container's disk, so it goes away when the Container stops, like the process.
const ROOT = "/run/processes";

// Runs the command in its own process group, so a kill also reaches its children. The group
// leader records its PID, then becomes the command. It runs in the foreground, because a shell
// starts background (&) jobs with SIGINT ignored.
// Output goes to files, so the process keeps running after the request that started it ends.
const RUN_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

// Prints one status line and the process.json line for each process directory.
// kill is a shell builtin, so this works in images without a kill binary.
const STATUS_SCRIPT = `for dir in "$@"; do
  [ -f "$dir/process.json" ] || continue
  if [ -e "$dir/exit-code" ]; then status="exited $(cat "$dir/exit-code")"
  elif [ ! -e "$dir/pid" ]; then status="starting"
  elif kill -0 "$(cat "$dir/pid")" 2>/dev/null; then status="running $(cat "$dir/pid")"
  elif [ -e "$dir/exit-code" ]; then status="exited $(cat "$dir/exit-code")"
  else status="lost"
  fi
  printf '%s\\n' "$status"
  cat "$dir/process.json"
  echo
done`;

// Exits 0 with the first matching line, or 3 once the process has exited without one.
const WAIT_FOR_LOG_SCRIPT = `dir=$1; pattern=$2
while :; do
  exited=false; [ -e "$dir/exit-code" ] && exited=true
  line=$(grep -h -m 1 -E -e "$pattern" "$dir/stdout.log" "$dir/stderr.log" 2>/dev/null | head -n 1)
  [ -n "$line" ] && { printf '%s\\n' "$line"; exit 0; }
  $exited && exit 3
  sleep 0.2
done`;

// Exits with the process's exit code, or 255 if it ended without recording one.
const WAIT_FOR_EXIT_SCRIPT = `dir=$1
while [ ! -e "$dir/exit-code" ]; do
  if [ -e "$dir/pid" ] && ! kill -0 "$(cat "$dir/pid")" 2>/dev/null && [ ! -e "$dir/exit-code" ]; then exit 255; fi
  sleep 0.2
done
exit "$(cat "$dir/exit-code")"`;

const ProcessRecord = z.object({
  id: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
  startedAt: z.string(),
});
type ProcessRecord = z.infer<typeof ProcessRecord>;

type ProcessStatus =
  | { state: "starting" }
  | { state: "running"; pid: number }
  | { state: "exited"; exitCode: number }
  // The process ended without recording an exit code, for example because its wrapper was killed.
  | { state: "lost" };

export type ProcessInfo = ProcessRecord & { status: ProcessStatus };

export interface StartOptions {
  id: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export type LogStream = "stdout" | "stderr";

export type WaitForLogResult =
  | { state: "matched"; line: string }
  | { state: "exited" }
  | { state: "timed-out" };

export type WaitForExitResult =
  | { state: "exited"; exitCode: number }
  | { state: "lost" }
  | { state: "timed-out" };

// Background processes for one Container. This is example code, not part of @cloudflare/sandbox.
export class Processes {
  readonly #container: Container;
  readonly #files: Files;

  constructor(container: Container, files: Files) {
    this.#container = container;
    this.#files = files;
  }

  // Returns undefined if a process with this ID already exists in this Container.
  async start(options: StartOptions): Promise<ProcessInfo | undefined> {
    const dir = directory(options.id);
    await this.#files.mkdir(ROOT, { recursive: true });
    try {
      // A non-recursive mkdir fails if the directory exists, so two starts cannot share an ID.
      await this.#files.mkdir(dir);
    } catch (cause) {
      if (SandboxFileError.is(cause) && cause.code === "EEXIST") return undefined;
      throw cause;
    }
    const record: ProcessRecord = {
      id: options.id,
      command: options.command,
      cwd: options.cwd,
      startedAt: new Date().toISOString(),
    };
    try {
      await this.#files.writeFile(`${dir}/process.json`, JSON.stringify(record));
      await this.#container.exec(["/bin/sh", "-c", RUN_SCRIPT, "run", dir, ...options.command], {
        cwd: options.cwd,
        env: options.env,
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (cause) {
      await this.#files.remove(dir, { recursive: true, force: true });
      throw cause;
    }
    return { ...record, status: { state: "starting" } };
  }

  async get(id: string): Promise<ProcessInfo | undefined> {
    const [process] = await this.#status([directory(id)]);
    return process;
  }

  async list(): Promise<ProcessInfo[]> {
    let entries: { name: string }[];
    try {
      entries = await this.#files.readDirectory(ROOT);
    } catch (cause) {
      if (SandboxFileError.is(cause) && cause.code === "ENOENT") return [];
      throw cause;
    }
    return this.#status(entries.map((entry) => directory(entry.name)));
  }

  // Sends a signal to the process group. Returns false if the process is not running.
  async kill(id: string, signal = "TERM"): Promise<boolean> {
    const process = await this.get(id);
    if (process?.status.state !== "running") return false;
    const result = await this.#run([
      "/bin/sh",
      "-c",
      'kill -s "$1" -- "-$2"',
      "kill",
      signal,
      String(process.status.pid),
    ]);
    return result.exitCode === 0;
  }

  async killAll(signal = "TERM"): Promise<string[]> {
    const killed: string[] = [];
    for (const process of await this.list()) {
      if (await this.kill(process.id, signal)) killed.push(process.id);
    }
    return killed;
  }

  // Removes the directories of processes that are no longer running.
  async cleanup(): Promise<string[]> {
    const removed: string[] = [];
    for (const process of await this.list()) {
      if (process.status.state === "exited" || process.status.state === "lost") {
        await this.#files.remove(directory(process.id), { recursive: true });
        removed.push(process.id);
      }
    }
    return removed;
  }

  readLog(id: string, stream: LogStream): Promise<Response> {
    return this.#files.readFile(`${directory(id)}/${stream}.log`);
  }

  // Streams the log from the start, and ends once the process exits.
  async followLog(id: string, stream: LogStream): Promise<Response | undefined> {
    const process = await this.get(id);
    if (process === undefined) return undefined;
    const path = `${directory(id)}/${stream}.log`;
    const tail =
      process.status.state === "running"
        ? ["tail", "-n", "+1", "-F", "--pid", String(process.status.pid), path]
        : ["cat", path];
    const output = await this.#container.exec(tail, { stderr: "ignore" });
    // Other content types can arrive all at once when the stream ends.
    return new Response(output.stdout, { headers: { "Content-Type": "text/event-stream" } });
  }

  async waitForLog(id: string, pattern: string, timeoutMs: number): Promise<WaitForLogResult> {
    const result = await this.#run(
      ["/bin/sh", "-c", WAIT_FOR_LOG_SCRIPT, "wait-for-log", directory(id), pattern],
      timeoutMs,
    );
    if (result.exitCode === 0) return { state: "matched", line: result.stdout.trimEnd() };
    if (result.exitCode === 3) return { state: "exited" };
    return { state: "timed-out" };
  }

  async waitForExit(id: string, timeoutMs: number): Promise<WaitForExitResult> {
    const result = await this.#run(
      ["/bin/sh", "-c", WAIT_FOR_EXIT_SCRIPT, "wait-for-exit", directory(id)],
      timeoutMs,
    );
    // The timeout kills the wait with SIGKILL, so 137 means it timed out.
    if (result.exitCode === 137) return { state: "timed-out" };
    if (result.exitCode === 255) return { state: "lost" };
    return { state: "exited", exitCode: result.exitCode };
  }

  async #status(directories: string[]): Promise<ProcessInfo[]> {
    if (directories.length === 0) return [];
    const result = await this.#run(["/bin/sh", "-c", STATUS_SCRIPT, "status", ...directories]);
    const lines = result.stdout.split("\n");
    const processes: ProcessInfo[] = [];
    for (let index = 0; index + 1 < lines.length; index += 2) {
      const record = ProcessRecord.parse(JSON.parse(lines[index + 1]));
      processes.push({ ...record, status: parseStatus(lines[index]) });
    }
    return processes;
  }

  async #run(command: string[], timeoutMs?: number): Promise<{ exitCode: number; stdout: string }> {
    // Not AbortSignal.timeout(): it stays armed after the command exits, and signalling an
    // exited process logs an internal error. Clear the timer instead.
    const abort = new AbortController();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => abort.abort(), timeoutMs);
    try {
      const process = await this.#container.exec(command, { signal: abort.signal });
      const output = await process.output();
      return { exitCode: output.exitCode, stdout: new TextDecoder().decode(output.stdout) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function directory(id: string): string {
  return `${ROOT}/${id}`;
}

function parseStatus(line: string): ProcessStatus {
  const [state, value] = line.split(" ");
  if (state === "running") return { state, pid: Number(value) };
  if (state === "exited") return { state, exitCode: Number(value) };
  if (state === "starting") return { state };
  return { state: "lost" };
}
