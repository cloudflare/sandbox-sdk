import { connect, type Socket } from 'node:net';
import type { Logger } from '@repo/shared';
import { encodeFrame, type Frame, FrameDecoder } from './protocol';
import type { ExtensionEventHandler } from './types';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: ExtensionEventHandler;
  timer?: ReturnType<typeof setTimeout>;
  // Tail of the (sequential) event-delivery chain. The final response is not
  // settled until this resolves, so streamed events are fully delivered before
  // the caller's `call` promise resolves: each handler is awaited in turn, so
  // no event is dropped or reordered (even when a handler is async).
  events: Promise<void>;
}

/**
 * Host-side client for a single sidecar. Connects to the sidecar's unix
 * socket, issues request frames, correlates responses by id, and forwards
 * streaming event frames to per-call handlers.
 *
 * One bridge instance per running sidecar; recreated whenever the sidecar is
 * (re)started.
 */
export class ExtensionBridge {
  #socket: Socket | null = null;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<number, PendingCall>();
  #nextId = 1;
  #closed = false;
  readonly #logger: Logger;
  readonly #extensionId: string;

  constructor(extensionId: string, logger: Logger) {
    this.#extensionId = extensionId;
    this.#logger = logger;
  }

  /**
   * Connect to the sidecar socket, retrying until it accepts or the timeout
   * elapses (the sidecar may still be starting up). Resolves once connected.
   */
  async connect(socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        await this.#tryConnect(socketPath);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    throw new Error(
      `Extension '${this.#extensionId}' sidecar did not accept a bridge connection within ${timeoutMs}ms${
        lastError ? `: ${lastError.message}` : ''
      }`
    );
  }

  #tryConnect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this.#attach(socket);
        resolve();
      });
    });
  }

  #attach(socket: Socket): void {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (error) => this.#down(error));
    socket.on('close', () =>
      this.#down(new Error('Extension bridge socket closed'))
    );
  }

  /**
   * The socket died (peer closed, error). Drop it so `connected` reports false
   * and subsequent calls fail fast / trigger a host restart, then reject any
   * in-flight calls. Without nulling the socket, `connected` would lie and a
   * later `call()` would write to a dead socket and hang forever.
   */
  #down(error: Error): void {
    if (this.#socket) {
      this.#socket.destroy();
      this.#socket = null;
    }
    this.#failAll(error);
  }

  #onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      const frameError =
        error instanceof Error ? error : new Error(String(error));
      this.#logger.error('Failed to decode extension frame', frameError, {
        extensionId: this.#extensionId
      });
      this.#down(frameError);
      return;
    }
    for (const frame of frames) {
      this.#dispatch(frame);
    }
  }

  #dispatch(frame: Frame): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) return;

    if (frame.t === 'evt') {
      // Deliver events sequentially and remember the tail so the final
      // response waits for them — no event is dropped or reordered.
      const onEvent = pending.onEvent;
      if (onEvent) {
        pending.events = pending.events.then(() =>
          onEvent(frame.event, frame.data)
        );
      }
      return;
    }

    if (frame.t !== 'res') return; // 'req' is host->sidecar only

    // res — settle only after all queued events have been delivered.
    const response = frame;
    this.#pending.delete(frame.id);
    pending.events.then(
      () => {
        if (response.ok) {
          pending.resolve(response.value);
        } else {
          pending.reject(
            Object.assign(new Error(response.error.message), {
              code: response.error.code
            })
          );
        }
      },
      (error) =>
        pending.reject(
          error instanceof Error ? error : new Error(String(error))
        )
    );
  }

  /**
   * Invoke a method on the sidecar. Streaming events emitted by the sidecar
   * before the final response are delivered to `onEvent`.
   *
   * `timeoutMs` bounds how long to wait for the final response. Omit it (the
   * default) for intentionally long-running calls such as code execution; the
   * call still rejects if the bridge drops.
   */
  call(
    method: string,
    args: unknown[],
    onEvent?: ExtensionEventHandler,
    timeoutMs?: number
  ): Promise<unknown> {
    if (this.#closed || !this.#socket) {
      return Promise.reject(
        new Error(`Extension '${this.#extensionId}' bridge is not connected`)
      );
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCall = {
        resolve: (value) => {
          if (pending.timer) clearTimeout(pending.timer);
          resolve(value);
        },
        reject: (error) => {
          if (pending.timer) clearTimeout(pending.timer);
          reject(error);
        },
        onEvent,
        events: Promise.resolve()
      };
      if (timeoutMs && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.#pending.delete(id)) {
            reject(
              new Error(
                `Extension '${this.#extensionId}' call '${method}' timed out after ${timeoutMs}ms`
              )
            );
          }
        }, timeoutMs);
      }
      this.#pending.set(id, pending);
      this.#socket?.write(encodeFrame({ t: 'req', id, method, args }));
    });
  }

  get connected(): boolean {
    return !this.#closed && this.#socket !== null;
  }

  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#failAll(new Error('Extension bridge closed'));
    socket?.destroy();
  }

  #failAll(error: Error): void {
    if (this.#pending.size === 0) return;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) {
      call.reject(error);
    }
  }
}
