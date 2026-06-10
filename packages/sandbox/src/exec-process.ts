import type { ExecEvent, ExecProcess, ExecResult } from '@repo/shared';

import { parseSSEStream } from './sse-parser';

/**
 * Options for creating an {@link ExecProcess}.
 * @internal
 */
export interface ExecProcessOptions {
  /** Factory that returns the buffered ExecResult (used by output()/then()) */
  buffered: () => Promise<ExecResult>;
  /** Factory that returns the SSE stream (used by .stdout/.stderr, started lazily on first read) */
  stream: () => Promise<ReadableStream<Uint8Array>>;
  signal?: AbortSignal;
}

/**
 * Create an {@link ExecProcess} that uses the **buffered** exec path for
 * `output()` / `then()` and the **streaming** SSE path for `.stdout` /
 * `.stderr`. Each path is started lazily — only when the caller actually
 * accesses it — so no extra container round-trips happen for the common
 * `await sandbox.exec(cmd)` case.
 *
 * @internal
 */
export function createExecProcess(opts: ExecProcessOptions): ExecProcess {
  return new SandboxExecProcess(opts);
}

class SandboxExecProcess implements ExecProcess {
  private readonly _opts: ExecProcessOptions;
  private _streamState: StreamState | null = null;
  private _bufferedPromise: Promise<ExecResult> | null = null;

  constructor(opts: ExecProcessOptions) {
    this._opts = opts;
  }

  get stdout(): ReadableStream<Uint8Array> {
    return this._ensureStreams().stdout;
  }

  get stderr(): ReadableStream<Uint8Array> {
    return this._ensureStreams().stderr;
  }

  get exitCode(): Promise<number> {
    return this._ensureStreams().exitCode;
  }

  output(): Promise<ExecResult> {
    if (!this._bufferedPromise) {
      this._bufferedPromise = this._opts.buffered();
    }
    return this._bufferedPromise;
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

  private _ensureStreams(): StreamState {
    if (this._streamState) return this._streamState;

    const encoder = new TextEncoder();
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
    exitCodePromise.catch(() => {});

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

    const signal = this._opts.signal;

    void this._opts
      .stream()
      .then(async (sseStream) => {
        for await (const event of parseSSEStream<ExecEvent>(
          sseStream,
          signal
        )) {
          switch (event.type) {
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
      })
      .catch((err) => {
        closeStreams();
        exitCodeReject(err instanceof Error ? err : new Error(String(err)));
      });

    this._streamState = { stdout, stderr, exitCode: exitCodePromise };
    return this._streamState;
  }
}

interface StreamState {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitCode: Promise<number>;
}
