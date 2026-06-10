import type { ExecEvent, ExecProcess, ExecResult } from '@repo/shared';

import { parseSSEStream } from './sse-parser';

/**
 * Read a ReadableStream<Uint8Array> to completion, returning the decoded text.
 */
async function readStreamAsText(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return result;
}

/**
 * Create an {@link ExecProcess} from an SSE event stream (or a promise of one).
 *
 * Accepts either a resolved `ReadableStream` or a `Promise<ReadableStream>`
 * so callers can kick off async setup (session resolution, RPC) and still
 * return `ExecProcess` synchronously. The stdout/stderr TransformStreams are
 * created immediately; the SSE demux starts once the promise resolves.
 *
 * @internal
 */
export function createExecProcess(
  command: string,
  sseStreamOrPromise:
    | ReadableStream<Uint8Array>
    | Promise<ReadableStream<Uint8Array>>,
  signal?: AbortSignal
): ExecProcess {
  const encoder = new TextEncoder();
  const startTime = Date.now();

  const controllers: {
    stdout: ReadableStreamDefaultController<Uint8Array> | null;
    stderr: ReadableStreamDefaultController<Uint8Array> | null;
  } = { stdout: null, stderr: null };

  let exitCodeResolve!: (code: number) => void;
  let exitCodeReject!: (err: Error) => void;
  const exitCodePromise = new Promise<number>((resolve, reject) => {
    exitCodeResolve = resolve;
    exitCodeReject = reject;
  });
  // Prevent unhandled rejection when exec() is fire-and-forget
  exitCodePromise.catch(() => {});

  let sessionId: string | undefined;
  let startTimestamp: string | undefined;

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controllers.stdout = controller;
    }
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controllers.stderr = controller;
    }
  });

  function closeStreams() {
    try {
      controllers.stdout?.close();
    } catch {
      // Already closed
    }
    try {
      controllers.stderr?.close();
    } catch {
      // Already closed
    }
  }

  async function consumeSSE(
    sseStream: ReadableStream<Uint8Array>
  ): Promise<void> {
    for await (const event of parseSSEStream<ExecEvent>(sseStream, signal)) {
      switch (event.type) {
        case 'start':
          sessionId = event.sessionId;
          startTimestamp = event.timestamp;
          break;

        case 'stdout':
          if (event.data && controllers.stdout) {
            controllers.stdout.enqueue(encoder.encode(event.data));
          }
          break;

        case 'stderr':
          if (event.data && controllers.stderr) {
            controllers.stderr.enqueue(encoder.encode(event.data));
          }
          break;

        case 'complete':
          closeStreams();
          exitCodeResolve(event.exitCode ?? 0);
          return;

        case 'error': {
          const err = new Error(event.data || 'Command execution failed');
          closeStreams();
          exitCodeReject(err);
          return;
        }
      }
    }

    closeStreams();
    exitCodeReject(new Error('Stream ended without completion event'));
  }

  // Kick off the SSE demux in the background. If the input is a promise
  // (lazy session resolution / RPC), we wait for it first.
  void Promise.resolve(sseStreamOrPromise)
    .then((stream) => consumeSSE(stream))
    .catch((err) => {
      closeStreams();
      exitCodeReject(err instanceof Error ? err : new Error(String(err)));
    });

  return new SandboxExecProcess(
    stdout,
    stderr,
    exitCodePromise,
    command,
    startTime,
    () => startTimestamp,
    () => sessionId
  );
}

class SandboxExecProcess implements ExecProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exitCode: Promise<number>;

  private readonly _command: string;
  private readonly _startTime: number;
  private readonly _getStartTimestamp: () => string | undefined;
  private readonly _getSessionId: () => string | undefined;

  constructor(
    stdout: ReadableStream<Uint8Array>,
    stderr: ReadableStream<Uint8Array>,
    exitCode: Promise<number>,
    command: string,
    startTime: number,
    getStartTimestamp: () => string | undefined,
    getSessionId: () => string | undefined
  ) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this._command = command;
    this._startTime = startTime;
    this._getStartTimestamp = getStartTimestamp;
    this._getSessionId = getSessionId;
  }

  output(): Promise<ExecResult> {
    return Promise.all([
      readStreamAsText(this.stdout),
      readStreamAsText(this.stderr),
      this.exitCode
    ]).then(([stdoutText, stderrText, code]) => ({
      success: code === 0,
      exitCode: code,
      stdout: stdoutText,
      stderr: stderrText,
      command: this._command,
      duration: Date.now() - this._startTime,
      timestamp:
        this._getStartTimestamp() ?? new Date(this._startTime).toISOString(),
      sessionId: this._getSessionId()
    }));
  }

  // biome-ignore lint/suspicious/noThenProperty: intentional PromiseLike implementation
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?:
      | ((value: ExecResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.output().then(onfulfilled, onrejected);
  }
}
