import type { PortWatchEvent, PortWatchSubscriptionAPI } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeLease } from '../../src/runtime';
import { waitForRuntimePort } from '../../src/runtime/port-readiness';

function subscription(
  stream: Promise<ReadableStream<PortWatchEvent>>,
  cancel: () => Promise<void> = async () => undefined
): PortWatchSubscriptionAPI {
  return {
    stream: vi.fn(() => stream),
    cancel: vi.fn(cancel),
    [Symbol.dispose]: vi.fn()
  };
}

function leaseWith(subscriptionPromise: Promise<PortWatchSubscriptionAPI>) {
  const release = vi.fn();
  const lease = {
    control: {
      ports: {
        openWatch: vi.fn(() => subscriptionPromise)
      }
    },
    retain: vi.fn(() => ({ release }))
  } as unknown as RuntimeLease;
  return { lease, release };
}

function timeoutReject(message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), 50);
  });
}

describe('waitForRuntimePort', () => {
  it('times out a hanging readiness read and cancels the subscription', async () => {
    const sub = subscription(
      Promise.resolve(
        new ReadableStream<PortWatchEvent>({
          pull: () => new Promise(() => undefined)
        })
      )
    );
    const { lease, release } = leaseWith(Promise.resolve(sub));

    await expect(
      waitForRuntimePort(lease, 8080, { timeout: 1 })
    ).rejects.toThrow(/Timed out waiting for runtime port/);

    expect(sub.cancel).toHaveBeenCalledTimes(1);
    expect(sub[Symbol.dispose]).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('aborts while opening the watch and releases the lease', async () => {
    const controller = new AbortController();
    const { lease, release } = leaseWith(new Promise(() => undefined));
    controller.abort(new Error('caller aborted'));

    await expect(
      waitForRuntimePort(lease, 8080, { signal: controller.signal })
    ).rejects.toThrow(/caller aborted/);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('aborts while creating the stream and cancels the subscription', async () => {
    const controller = new AbortController();
    const sub = subscription(new Promise(() => undefined));
    const { lease, release } = leaseWith(Promise.resolve(sub));

    const waiting = waitForRuntimePort(lease, 8080, {
      signal: controller.signal
    });
    controller.abort(new Error('external abort'));

    await expect(waiting).rejects.toThrow(/external abort/);
    expect(sub.cancel).toHaveBeenCalledTimes(1);
    expect(sub[Symbol.dispose]).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not wait for hanging reader and subscription cancellation on timeout', async () => {
    const sub = subscription(
      Promise.resolve(
        new ReadableStream<PortWatchEvent>({
          pull: () => new Promise(() => undefined),
          cancel: () => new Promise(() => undefined)
        })
      ),
      () => new Promise(() => undefined)
    );
    const { lease, release } = leaseWith(Promise.resolve(sub));

    await expect(
      Promise.race([
        waitForRuntimePort(lease, 8080, { timeout: 1 }),
        timeoutReject('cleanup blocked')
      ])
    ).rejects.toThrow(/Timed out waiting for runtime port/);

    expect(sub.cancel).toHaveBeenCalledTimes(1);
    expect(sub[Symbol.dispose]).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not wait for hanging reader and subscription cancellation on abort', async () => {
    const controller = new AbortController();
    const sub = subscription(
      Promise.resolve(
        new ReadableStream<PortWatchEvent>({
          pull: () => new Promise(() => undefined),
          cancel: () => new Promise(() => undefined)
        })
      ),
      () => new Promise(() => undefined)
    );
    const { lease, release } = leaseWith(Promise.resolve(sub));

    const waiting = waitForRuntimePort(lease, 8080, {
      signal: controller.signal
    });
    controller.abort(new Error('external abort'));

    await expect(
      Promise.race([waiting, timeoutReject('cleanup blocked')])
    ).rejects.toThrow(/external abort/);

    expect(sub.cancel).toHaveBeenCalledTimes(1);
    expect(sub[Symbol.dispose]).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('removes abort listeners without creating an unhandled finally rejection', async () => {
    const failure = new Error('open failed');
    const { lease, release } = leaseWith(Promise.reject(failure));

    await expect(waitForRuntimePort(lease, 8080)).rejects.toThrow(
      /open failed/
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
