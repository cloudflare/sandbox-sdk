import { translateRPCError } from '../container-control/rpc-error';
import type { ProcessSubscriptionRPC } from './rpc-types';

interface RemoteSubscriptionOptions {
  signal?: AbortSignal;
  operation?: string;
  abortError?: () => Error;
}

/** Exposes a remote Workers RPC subscription as a caller-owned local stream. */
export async function openRemoteSubscription<T>(
  subscriptionPromise: Promise<ProcessSubscriptionRPC<T>>,
  options: RemoteSubscriptionOptions = {}
): Promise<ReadableStream<T>> {
  let subscription: ProcessSubscriptionRPC<T> | undefined;
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

  let source: ReadableStream<T>;
  try {
    source = await raceSetup(subscription.stream());
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

  let stopped = false;
  let controller: ReadableStreamDefaultController<T> | undefined;
  const stop = (error?: Error): void => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Remote subscription release below remains authoritative.
    }
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
        const result = await reader.read();
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
