/**
 * Unified `SandboxProcess` implementation.
 *
 * Wraps the existing `ProcessService` plumbing (start / kill / getProcess /
 * getProcessLogs / streamProcessLogs / waitForLog / waitForPort /
 * waitForExit) into a single handle whose shape mirrors `ExecProcess` from
 * the Cloudflare Containers runtime contract.
 *
 * See `docs/EXEC_MIGRATION.md` for migration guidance.
 */

import type {
  LogEvent,
  ProcessStatus,
  SandboxExecOutput,
  SandboxProcess,
  SandboxProcessPromise,
  WaitForExitResult,
  WaitForLogResult,
  WaitForPortOptions
} from '@repo/shared';
import { parseSSEStream } from './sse-parser';

// ---------------------------------------------------------------------------
// Dependency surface
//
// The set of operations `SandboxProcessImpl` needs from the owning Sandbox.
// Decoupled into an interface so the class can be unit-tested without
// instantiating a Durable Object, and so we don't grow `sandbox.ts` further.
// ---------------------------------------------------------------------------

export interface SandboxProcessDeps {
  /** Open the multiplexed log stream for a process (replay-then-tail). */
  openLogStream(processId: string): Promise<ReadableStream<Uint8Array>>;
  /** Read accumulated logs as decoded strings. */
  readLogs(processId: string): Promise<{ stdout: string; stderr: string }>;
  /** Fetch the current `ProcessStatus`. */
  fetchStatus(processId: string): Promise<ProcessStatus>;
  /** Terminate the process via the container. */
  killProcess(processId: string): Promise<void>;
  /** Wait for a port to become ready, scoped to the process lifetime. */
  waitForPort(
    processId: string,
    command: string,
    port: number,
    options?: WaitForPortOptions
  ): Promise<void>;
  /** Match a log pattern against the live stream (and replay). */
  waitForLogPattern(
    processId: string,
    command: string,
    pattern: string | RegExp,
    timeoutMs?: number
  ): Promise<WaitForLogResult>;
  /** Wait for the process to reach a terminal state. */
  waitForProcessExit(
    processId: string,
    command: string,
    timeoutMs?: number
  ): Promise<WaitForExitResult>;
}

// ---------------------------------------------------------------------------
// Demultiplexer: ReadableStream<Uint8Array> of SSE log frames →
//   { stdout, stderr } ReadableStream<Uint8Array> + exitCode Promise.
//
// Frame schema (see packages/sandbox-container/src/control-plane/api.ts
// `streamProcessLogs`):
//   { type: 'stdout', data, processId, timestamp }
//   { type: 'stderr', data, processId, timestamp }
//   { type: 'exit',   exitCode, processId, timestamp }
//   { type: 'error',  data?, processId, timestamp }    // optional
//
// The two byte streams emit decoded `data` strings as Uint8Array chunks.
// The exitCode promise resolves on the first 'exit' frame; if the stream
// closes without one, it rejects.
// ---------------------------------------------------------------------------

interface DemuxResult {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
}

function demultiplexLogStream(
  source: ReadableStream<Uint8Array>,
  options: {
    stdout: 'pipe' | 'ignore';
    stderr: 'pipe' | 'ignore' | 'combined';
  }
): DemuxResult {
  const encoder = new TextEncoder();

  const controllers: {
    stdout: ReadableStreamDefaultController<Uint8Array> | null;
    stderr: ReadableStreamDefaultController<Uint8Array> | null;
  } = { stdout: null, stderr: null };
  let exitResolve!: (code: number) => void;
  let exitReject!: (err: Error) => void;
  const exitCode = new Promise<number>((res, rej) => {
    exitResolve = res;
    exitReject = rej;
  });
  let settled = false;
  const resolveExit = (code: number) => {
    if (settled) return;
    settled = true;
    exitResolve(code);
  };
  const rejectExit = (err: Error) => {
    if (settled) return;
    settled = true;
    exitReject(err);
  };

  const wantStdout = options.stdout === 'pipe';
  const wantStderr = options.stderr === 'pipe';
  const combined = options.stderr === 'combined';

  const stdoutStream = wantStdout
    ? new ReadableStream<Uint8Array>({
        start(c) {
          controllers.stdout = c;
        }
      })
    : null;
  const stderrStream = wantStderr
    ? new ReadableStream<Uint8Array>({
        start(c) {
          controllers.stderr = c;
        }
      })
    : null;

  void (async () => {
    try {
      for await (const event of parseSSEStream<LogEvent>(source)) {
        if (event.type === 'stdout' && event.data) {
          controllers.stdout?.enqueue(encoder.encode(event.data));
        } else if (event.type === 'stderr' && event.data) {
          if (combined) {
            controllers.stdout?.enqueue(encoder.encode(event.data));
          } else {
            controllers.stderr?.enqueue(encoder.encode(event.data));
          }
        } else if (event.type === 'exit') {
          resolveExit(event.exitCode ?? 0);
        } else if (event.type === 'error') {
          rejectExit(
            new Error(event.data || 'Process stream emitted error frame')
          );
        }
      }
      // Stream ended; if no exit frame was seen, treat as abnormal.
      if (!settled) {
        rejectExit(new Error('Process stream closed without exit event'));
      }
    } catch (err) {
      rejectExit(err instanceof Error ? err : new Error(String(err)));
    } finally {
      try {
        controllers.stdout?.close();
      } catch {
        /* already closed */
      }
      try {
        controllers.stderr?.close();
      } catch {
        /* already closed */
      }
    }
  })();

  return { stdout: stdoutStream, stderr: stderrStream, exitCode };
}

/**
 * Wrap `inner` as a Promise that fires `onFirstAwait` exactly once, the
 * first time any of `.then` / `.catch` / `.finally` is called. Plain field
 * access (e.g. `obj.exitCode` evaluated by a property spread) does NOT
 * trigger it.
 *
 * Used to make `SandboxProcess.exitCode` lazily kick off the demux
 * subscription only when a caller actually awaits it.
 */
function makeLazyExitPromise(
  inner: Promise<number>,
  onFirstAwait: () => void
): Promise<number> {
  let triggered = false;
  const trigger = () => {
    if (triggered) return;
    triggered = true;
    onFirstAwait();
  };
  // The whole point of this helper is that `.then` has a side effect of
  // triggering the demux subscription; the Biome rule against `then` on
  // plain objects doesn't apply because the result IS a thenable used as
  // a Promise.
  const lazy = {
    // biome-ignore lint/suspicious/noThenProperty: lazy thenable by design.
    then(onFulfilled, onRejected) {
      trigger();
      return inner.then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      trigger();
      return inner.catch(onRejected);
    },
    finally(onFinally) {
      trigger();
      return inner.finally(onFinally);
    },
    [Symbol.toStringTag]: 'Promise'
  } as Promise<number>;
  return lazy;
}

// ---------------------------------------------------------------------------
// SandboxProcessImpl
// ---------------------------------------------------------------------------

export interface SandboxProcessInit {
  id: string;
  pid: number;
  command: string;
  sessionId?: string;
  startTime: Date;
  /** Initial status reported by the container after `startProcess`. */
  status: ProcessStatus;
  /**
   * `pipe` for owners (live multiplexed stream), `replay` for re-attach.
   * Either way we read the same `streamProcessLogs` endpoint; the flag is
   * carried for diagnostics.
   */
  ownership: 'owner' | 'attached';
  stdout: 'pipe' | 'ignore';
  stderr: 'pipe' | 'ignore' | 'combined';
  /**
   * Stdin handle exposed to the caller. `null` when no stdin was
   * requested (the container redirects from `/dev/null`); a
   * `WritableStream<Uint8Array>` when `stdin: "pipe"` was requested.
   *
   * The SDK constructs a `TransformStream` whose readable half is sent
   * over RPC as the process's stdin source, and whose writable half is
   * surfaced here so callers can write bytes incrementally. Closing the
   * writer flushes EOF into the spawned command.
   */
  stdin: WritableStream<Uint8Array> | null;
}

/**
 * Internal-only implementation. Class instances cannot cross the workerd
 * JsRpc boundary directly (workerd refuses with "Could not serialize object
 * of type 'SandboxProcessImpl'"). Callers in the Durable Object that need
 * to send a `SandboxProcess` to a Worker must go through
 * `toRpcSandboxProcess()`, which produces a plain object literal whose
 * methods workerd auto-stubs and whose fields/streams cross by value.
 */
export class SandboxProcessImpl implements SandboxProcess {
  readonly id: string;
  readonly pid: number;
  readonly command: string;
  readonly sessionId?: string;
  readonly startTime: Date;
  /**
   * Writer-side of the SDK-managed stdin `TransformStream`. Not declared
   * `readonly` because the field is assigned in the constructor from
   * `init.stdin`; the public `SandboxProcess` contract narrows it to
   * `readonly` via the interface.
   */
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;

  private readonly deps: SandboxProcessDeps;
  private readonly stdoutMode: 'pipe' | 'ignore';
  private readonly stderrMode: 'pipe' | 'ignore' | 'combined';
  /**
   * Memoised demultiplex result. Initialised lazily on first access to
   * `stdout` / `stderr` / `exitCode` / `output()` so handles whose caller
   * only uses `kill()`, `status()`, `getLogs()`, or `waitForLog/Port/Exit`
   * never open the log SSE stream.
   */
  private demuxPromise?: Promise<DemuxResult>;
  private readonly exitResolvers: {
    promise: Promise<number>;
    resolve: (code: number) => void;
    reject: (err: Error) => void;
  };
  private terminalStatus?: ProcessStatus;

  constructor(init: SandboxProcessInit, deps: SandboxProcessDeps) {
    this.id = init.id;
    this.pid = init.pid;
    this.command = init.command;
    this.sessionId = init.sessionId;
    this.startTime = init.startTime;
    this.deps = deps;
    this.stdoutMode = init.stdout;
    this.stderrMode = init.stderr;
    // `init.status` is the at-spawn snapshot; we only retain the terminal
    // status once exit settles.
    void init.status;
    // `init.ownership` is informational; behaviour is identical for owner
    // and re-attached handles — both demux the same `streamProcessLogs`
    // SSE feed, the container-side just stages a replay-then-tail for
    // attached handles.
    void init.ownership;

    // Writer-side of the SDK-managed stdin `TransformStream` (see
    // `SandboxProcessInit.stdin`). `null` for handles that didn't request
    // stdin (`stdin === "ignore"` semantically) and for re-attached
    // handles (the original owner holds the writer).
    this.stdin = init.stdin;

    // Lazy `stdout` / `stderr`: a `ReadableStream` whose `start()` triggers
    // the demux on first read. ReadableStream's `start()` is invoked when
    // a consumer first attaches a reader, so the underlying RPC stays cold
    // until somebody reads.
    this.stdout =
      this.stdoutMode === 'ignore' ? null : this.makeLazyChannel('stdout');
    this.stderr =
      this.stderrMode === 'ignore' || this.stderrMode === 'combined'
        ? null
        : this.makeLazyChannel('stderr');

    // Exit code is a Promise that settles when the underlying demux's
    // `exit` event fires. We expose our own deferred so callers can
    // `await proc.exitCode` without first touching a stream.
    let resolve!: (code: number) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Mark as observed so node doesn't yell about unhandled rejections
    // for callers who never await it (e.g. fire-and-forget kill paths).
    promise.catch(() => {});
    this.exitResolvers = { promise, resolve, reject };
    // Lazy thenable: triggers `ensureDemux()` on first `.then` /
    // `.catch` / `.finally`. Plain property reads (e.g. spreading into
    // a DTO for RPC) do not trigger anything.
    this.exitCode = makeLazyExitPromise(promise, () => void this.ensureDemux());
  }

  /**
   * Promise resolving to the process exit code.
   *
   * Wraps the underlying deferred so the first call to `.then` / `.catch` /
   * `.finally` (i.e. `await proc.exitCode`) lazily triggers the demux
   * subscription. Plain property reads (e.g. `proc.exitCode` evaluated by
   * `toRpcSandboxProcess` while marshalling the DTO across the DO RPC
   * boundary) do NOT trigger the demux — only awaits do. This is required
   * so handles that only call `kill()` / `waitForLog()` / `waitForPort()`
   * never open the log SSE.
   */
  readonly exitCode: Promise<number>;

  // ---- lazy demux plumbing -------------------------------------------------

  private ensureDemux(): Promise<DemuxResult> {
    if (!this.demuxPromise) {
      this.demuxPromise = (async () => {
        const source = await this.deps.openLogStream(this.id);
        const demux = demultiplexLogStream(source, {
          stdout: this.stdoutMode,
          stderr: this.stderrMode
        });
        // Wire the demux's exit event into our deferred so consumers
        // awaiting `proc.exitCode` don't need to also drain a stream.
        demux.exitCode.then(
          (code) => {
            this.terminalStatus =
              code === 0 ? 'completed' : code < 0 ? 'killed' : 'failed';
            this.exitResolvers.resolve(code);
          },
          (err) => {
            this.terminalStatus = 'error';
            this.exitResolvers.reject(
              err instanceof Error ? err : new Error(String(err))
            );
          }
        );
        return demux;
      })();
    }
    return this.demuxPromise;
  }

  /**
   * Build the user-facing `proc.stdout` / `proc.stderr` stream as a thin
   * proxy that initiates demultiplexing on first read. The proxy reader
   * forwards from the demuxed source stream and propagates close/cancel.
   */
  private makeLazyChannel(
    which: 'stdout' | 'stderr'
  ): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const acquireReader =
      async (): Promise<ReadableStreamDefaultReader<Uint8Array> | null> => {
        if (reader) return reader;
        const demux = await this.ensureDemux();
        const source = which === 'stdout' ? demux.stdout : demux.stderr;
        if (!source) return null;
        reader = source.getReader();
        return reader;
      };

    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const r = await acquireReader();
          if (!r) {
            controller.close();
            return;
          }
          try {
            const { value, done } = await r.read();
            if (done) controller.close();
            else if (value) controller.enqueue(value);
          } catch (err) {
            controller.error(err);
          }
        },
        cancel: async (reason) => {
          try {
            await reader?.cancel(reason);
          } catch {
            /* already cancelled */
          }
        }
      },
      // highWaterMark: 0 keeps the queue empty until a consumer reads, so the
      // underlying log SSE connection is never opened for handles that nobody
      // reads (e.g. callers using only `kill()` / `waitForPort()`). Without
      // this, the default highWaterMark of 1 triggers `pull` at construction
      // time.
      new CountQueuingStrategy({ highWaterMark: 0 })
    );
  }

  // ---- ExecProcess parity --------------------------------------------------

  kill(signal: number | string = 15 /* SIGTERM */): void {
    normalizeSignal(signal);
    // Fire-and-forget to match the synchronous `ExecProcess.kill` shape.
    void this.deps.killProcess(this.id).catch(() => {
      /* swallow; container-side already logs */
    });
  }

  async output(options?: {
    encoding?: 'utf8' | 'buffer';
  }): Promise<SandboxExecOutput> {
    const enc = options?.encoding ?? 'utf8';
    const startedAt = Date.now();

    const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
      this.stdout ? drain(this.stdout) : Promise.resolve(EMPTY),
      this.stderr ? drain(this.stderr) : Promise.resolve(EMPTY),
      this.exitCode
    ]);

    const decode = (b: Uint8Array): string | ArrayBuffer =>
      enc === 'utf8' ? new TextDecoder().decode(b) : asArrayBuffer(b);

    return {
      stdout: decode(stdoutBytes),
      stderr: decode(stderrBytes),
      exitCode,
      success: exitCode === 0,
      duration: Date.now() - startedAt,
      command: this.command,
      timestamp: this.startTime.toISOString(),
      sessionId: this.sessionId
    };
  }

  /**
   * RPC-safe alternative to `output()` for cross-DO-boundary calls.
   *
   * The standard `output()` drains the live `stdout` / `stderr` streams
   * that workerd has already shipped to the calling Worker. When invoked
   * over RPC, those streams are remote-owned and cannot also be read
   * locally on the DO without colliding ("This ReadableStream is
   * currently locked to a reader.").
   *
   * `outputViaLogs` sidesteps this by reading the per-process log file
   * (the same source `getLogs()` returns) plus awaiting `waitForExit()`
   * for the exit code. The data is identical to what the live streams
   * carry but the source is independent.
   *
   * The `encoding` option works the same way as `output()`; the default
   * is utf-8 strings.
   */
  async outputViaLogs(options?: {
    encoding?: 'utf8' | 'buffer';
  }): Promise<SandboxExecOutput> {
    const enc = options?.encoding ?? 'utf8';
    const startedAt = Date.now();

    // Wait for the process to exit before reading logs — otherwise the
    // log file may be missing the tail of output that's still being
    // flushed by the labelers.
    const { exitCode } = await this.deps.waitForProcessExit(
      this.id,
      this.command
    );
    const logs = await this.deps.readLogs(this.id);

    const decodeUtf = (s: string): string | ArrayBuffer =>
      enc === 'utf8' ? s : new TextEncoder().encode(s).buffer;

    return {
      stdout: decodeUtf(logs.stdout),
      stderr: decodeUtf(logs.stderr),
      exitCode,
      success: exitCode === 0,
      duration: Date.now() - startedAt,
      command: this.command,
      timestamp: this.startTime.toISOString(),
      sessionId: this.sessionId
    };
  }

  // ---- sandbox extensions --------------------------------------------------

  async status(): Promise<ProcessStatus> {
    if (this.terminalStatus) return this.terminalStatus;
    return this.deps.fetchStatus(this.id);
  }

  /** @deprecated Use `status()` (alias kept for one release for `Process` parity). */
  getStatus(): Promise<ProcessStatus> {
    return this.status();
  }

  getLogs(): Promise<{ stdout: string; stderr: string }> {
    return this.deps.readLogs(this.id);
  }

  waitForLog(
    pattern: string | RegExp,
    timeoutMs?: number
  ): Promise<WaitForLogResult> {
    return this.deps.waitForLogPattern(
      this.id,
      this.command,
      pattern,
      timeoutMs
    );
  }

  waitForPort(port: number, options?: WaitForPortOptions): Promise<void> {
    return this.deps.waitForPort(this.id, this.command, port, options);
  }

  waitForExit(timeoutMs?: number): Promise<WaitForExitResult> {
    return this.deps.waitForProcessExit(this.id, this.command, timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// SandboxProcessPromise — Bun.spawn-style thenable wrapper.
// ---------------------------------------------------------------------------

export function createSandboxProcessPromise(
  spawn: Promise<SandboxProcess>
): SandboxProcessPromise {
  // Decorate the underlying promise so callers can write either of:
  //   const proc = await sandbox.exec(cmd);          // SandboxProcess
  //   const out  = await sandbox.exec(cmd).output(); // SandboxExecOutput
  //   const text = await sandbox.exec(cmd).text();   // string
  const promise = spawn as SandboxProcessPromise;
  promise.output = async (opts) => (await spawn).output(opts);
  promise.text = async () => {
    const out = await (await spawn).output({ encoding: 'utf8' });
    return out.stdout as string;
  };
  promise.json = async <T>() => JSON.parse(await promise.text()) as T;
  promise.kill = async (signal) => {
    (await spawn).kill(signal);
  };
  return promise;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const EMPTY = new Uint8Array();

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGSTOP: 19,
  SIGCONT: 18
};

function normalizeSignal(signal: number | string): number {
  if (typeof signal === 'number') return signal;
  const n = SIGNAL_NUMBERS[signal];
  if (n === undefined) {
    throw new Error(`Unknown signal: ${signal}`);
  }
  return n;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // Slice to detach from any larger backing buffer.
  return u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength
  ) as ArrayBuffer;
}

/** Normalize a signal that came in as `number | string` for external use. */
export { normalizeSignal };

// ---------------------------------------------------------------------------
// stdin resolution
//
// `SandboxExecOptions.stdin` accepts three convenience forms:
//   - `"pipe"`             — SDK exposes `proc.stdin` as a `WritableStream`.
//   - `ReadableStream<Uint8Array>` — piped directly into the process.
//   - `string`             — utf-8 encoded into a single-chunk stream.
//
// The container RPC only accepts a `ReadableStream<Uint8Array>`. This
// helper produces both halves: the readable side to send across RPC, and
// (for the `"pipe"` case only) the writable side to surface back to the
// caller on `proc.stdin`.
// ---------------------------------------------------------------------------

export interface ResolvedStdin {
  stdinSource: ReadableStream<Uint8Array> | undefined;
  stdinWriter: WritableStream<Uint8Array> | null;
}

export function resolveStdinForRpc(
  stdin: ReadableStream<Uint8Array> | string | 'pipe' | undefined
): ResolvedStdin {
  if (stdin === undefined) {
    return { stdinSource: undefined, stdinWriter: null };
  }

  if (stdin === 'pipe') {
    // `TransformStream` gives us a back-pressuring pair: caller writes
    // into `writable`, container reads from `readable`.
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    return {
      stdinSource: transform.readable,
      stdinWriter: transform.writable
    };
  }

  if (typeof stdin === 'string') {
    const bytes = new TextEncoder().encode(stdin);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    return { stdinSource: source, stdinWriter: null };
  }

  // Already a `ReadableStream<Uint8Array>` — pass through; user already
  // owns the stream so we don't expose a writer.
  return { stdinSource: stdin, stdinWriter: null };
}

// ---------------------------------------------------------------------------
// toRpcSandboxProcess
//
// Convert a `SandboxProcessImpl` (class instance, not workerd-serializable)
// into a plain `SandboxProcess`-shaped object that survives a Durable
// Object RPC return. Mirrors the legacy `createProcessFromDTO` pattern:
//
//   - Data fields are copied by value.
//   - Streams and the `exitCode` promise are copied by reference and cross
//     the JsRpc boundary using workerd's built-in support for them.
//   - Methods are bound to the underlying impl and become RPC callbacks
//     when the object is shipped across the boundary.
//
// The returned object is `SandboxProcess`-shaped (sync property access for
// `stdin/stdout/stderr/pid/exitCode/id/...`), so consumers can use it the
// same way whether they receive it locally (inside the DO) or across RPC.
// ---------------------------------------------------------------------------

export function toRpcSandboxProcess(impl: SandboxProcessImpl): SandboxProcess {
  // Capture the streams once. workerd ships ReadableStream / WritableStream
  // across the JsRpc boundary as remote streams; reads on the Worker side
  // pull bytes through the transport from the DO source. The DO must NOT
  // also try to read these streams locally (e.g. via `impl.output()`)
  // because workerd has effectively locked them as the RPC source.
  //
  // To avoid the conflict we route `output()` to a separate path:
  // `__outputViaLogs` runs on the DO, drains the per-process log file
  // (which is independent of the live SSE stream that workerd is
  // shipping), and returns a buffered `SandboxExecOutput` to the Worker.
  // The Worker still sees the live `stdout` / `stderr` streams for
  // incremental reading.
  return {
    id: impl.id,
    pid: impl.pid,
    command: impl.command,
    sessionId: impl.sessionId,
    startTime: impl.startTime,
    stdin: impl.stdin,
    stdout: impl.stdout,
    stderr: impl.stderr,
    exitCode: impl.exitCode,
    output: (opts) => impl.outputViaLogs(opts),
    kill: (signal) => impl.kill(signal),
    status: () => impl.status(),
    getLogs: () => impl.getLogs(),
    waitForLog: (pattern, timeoutMs) => impl.waitForLog(pattern, timeoutMs),
    waitForPort: (port, options) => impl.waitForPort(port, options),
    waitForExit: (timeoutMs) => impl.waitForExit(timeoutMs)
  };
}
