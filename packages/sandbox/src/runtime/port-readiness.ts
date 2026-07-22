import type {
  PortWatchEvent,
  PortWatchSubscriptionAPI,
  WaitForPortOptions
} from '@repo/shared';
import type { RuntimeLease } from './operation-runner';

export async function waitForRuntimePort(
  lease: RuntimeLease,
  port: number,
  options: WaitForPortOptions = {}
): Promise<void> {
  const hold = lease.retain();
  const abort = createCombinedAbort(options.signal, options.timeout);
  let subscription: PortWatchSubscriptionAPI | undefined;
  let reader: ReadableStreamDefaultReader<PortWatchEvent> | undefined;

  try {
    subscription = await abort.race(
      lease.control.ports.openWatch(port, {
        mode: options.mode,
        path: options.path,
        status: options.status,
        interval: options.interval
      })
    );
    const stream = await abort.race(subscription.stream());
    reader = stream.getReader();
    while (true) {
      const { done, value } = await abort.race(reader.read());
      if (done) break;
      if (value.type === 'ready') return;
      if (value.type === 'error') throw new Error(value.error);
    }
    throw new Error(`Port ${port} readiness watch ended before ready`);
  } finally {
    abort.cleanup();
    observe(reader?.cancel());
    observe(subscription?.cancel());
    subscription?.[Symbol.dispose]();
    hold.release();
  }
}

function observe(promise: Promise<unknown> | undefined): void {
  promise?.catch(() => undefined);
}

type CombinedAbort = {
  race<T>(promise: Promise<T>): Promise<T>;
  cleanup(): void;
};

function createCombinedAbort(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): CombinedAbort {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (externalSignal?.aborted) {
    abort(externalSignal.reason);
  } else if (externalSignal) {
    const listener = () => abort(externalSignal.reason);
    externalSignal.addEventListener('abort', listener, { once: true });
    listeners.push(() => externalSignal.removeEventListener('abort', listener));
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      abort(new Error('Timed out waiting for runtime port'));
    }, timeoutMs);
  }

  return {
    race: <T>(promise: Promise<T>) => {
      if (controller.signal.aborted)
        return Promise.reject(controller.signal.reason);
      return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          const listener = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', listener, { once: true });
          promise.then(
            () => controller.signal.removeEventListener('abort', listener),
            () => controller.signal.removeEventListener('abort', listener)
          );
        })
      ]);
    },
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of listeners) remove();
    }
  };
}
