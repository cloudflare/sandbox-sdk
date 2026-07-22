import { RpcTarget } from 'cloudflare:workers';
import { translateRPCError } from '../container-control/rpc-error';
import type {
  ProcessPullSubscriptionRPC,
  ProcessSubscriptionRPC
} from './rpc-types';

interface RemoteSubscriptionOptions {
  protocol: 'stream' | 'pull';
  signal?: AbortSignal;
  operation?: string;
  abortError?: () => Error;
}

/** Keeps a stream local to its Durable Object and exposes pull RPC methods. */
export class PullSubscriptionTarget<T>
  extends RpcTarget
  implements ProcessPullSubscriptionRPC<T>
{
  readonly #reader: ReadableStreamDefaultReader<T>;
  readonly #onRelease: (() => void) | undefined;
  #released = false;

  constructor(stream: ReadableStream<T>, onRelease?: () => void) {
    super();
    this.#reader = stream.getReader();
    this.#onRelease = onRelease;
  }

  async next(): Promise<ReadableStreamReadResult<T>> {
    if (this.#released) return { done: true, value: undefined };
    try {
      const result = await this.#reader.read();
      if (result.done) this.#release();
      return result;
    } catch (error) {
      this.#release();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (this.#released) return;
    try {
      await this.#reader.cancel();
    } finally {
      this.#release();
    }
  }

  [Symbol.dispose](): void {
    if (this.#released) return;
    void this.#reader.cancel().catch(() => undefined);
    this.#release();
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#onRelease?.();
  }
}

/** Exposes a remote Workers RPC subscription as a caller-owned local stream. */
export async function openRemoteSubscription<T>(
  subscriptionPromise: Promise<
    ProcessSubscriptionRPC<T> | ProcessPullSubscriptionRPC<T>
  >,
  options: RemoteSubscriptionOptions
): Promise<ReadableStream<T>> {
  let subscription:
    | ProcessSubscriptionRPC<T>
    | ProcessPullSubscriptionRPC<T>
    | undefined;
  let releaseRequested = false;
  let cleanupStarted = false;
  const release = (): void => {
    releaseRequested = true;
    if (cleanupStarted || subscription === undefined) return;
    cleanupStarted = true;
    try {
      void subscription.cancel().catch(() => undefined);
    } catch {
      // Local disposal still runs after a synchronous RPC failure.
    }
    try {
      subscription[Symbol.dispose]();
    } catch {
      // Cleanup must not replace the consumer's result.
    }
  };

  const signal = options.signal;
  const aborted = (): Error =>
    options.abortError?.() ??
    (signal?.reason instanceof Error
      ? signal.reason
      : new Error('Operation aborted'));
  const raceSetup = async <U>(setup: Promise<U>): Promise<U> => {
    if (signal === undefined) return setup;
    if (signal.aborted) {
      release();
      throw aborted();
    }
    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => {
        release();
        reject(aborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([setup, abort]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  };

  try {
    subscription = await raceSetup(
      subscriptionPromise.then((value) => {
        subscription = value;
        if (releaseRequested) release();
        return value;
      })
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    translateRPCError(error, {
      operation: options.operation ?? 'open process subscription'
    });
  }

  if (subscription === undefined)
    throw new Error('Process subscription acquisition did not complete');

  let read: () => Promise<ReadableStreamReadResult<T>>;
  let cancelReader: () => void;
  if (options.protocol === 'pull') {
    const pullSubscription = subscription as ProcessPullSubscriptionRPC<T>;
    read = () => pullSubscription.next();
    cancelReader = () => undefined;
  } else {
    const streamSubscription = subscription as ProcessSubscriptionRPC<T>;
    let source: ReadableStream<T>;
    try {
      source = await raceSetup(streamSubscription.stream());
    } catch (error) {
      release();
      if (signal?.aborted) throw error;
      translateRPCError(error, {
        operation: options.operation ?? 'open process subscription'
      });
    }

    let reader: ReadableStreamDefaultReader<T>;
    try {
      reader = source.getReader();
    } catch (error) {
      release();
      translateRPCError(error, {
        operation: options.operation ?? 'read process subscription'
      });
    }
    read = () => reader.read();
    cancelReader = () => {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // Remote subscription release below remains authoritative.
      }
    };
  }

  let stopped = false;
  let controller: ReadableStreamDefaultController<T> | undefined;
  const stop = (error?: Error): void => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
    cancelReader();
    release();
    if (error !== undefined) controller?.error(error);
  };
  const onAbort = (): void => stop(aborted());

  return new ReadableStream<T>({
    start(localController) {
      controller = localController;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    },
    async pull(localController) {
      if (stopped) return;
      try {
        const result = await read();
        if (stopped) return;
        if (result.done) {
          stopped = true;
          signal?.removeEventListener('abort', onAbort);
          release();
          localController.close();
          return;
        }
        localController.enqueue(result.value);
      } catch (error) {
        stop();
        translateRPCError(error, {
          operation: options.operation ?? 'consume process subscription'
        });
      }
    },
    cancel() {
      stop();
    }
  });
}
