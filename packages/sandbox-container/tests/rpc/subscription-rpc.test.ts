import { describe, expect, it, vi } from 'bun:test';
import { StreamSubscriptionRPC } from '../../src/control-plane/subscription-rpc';

function cancellableSource<T>(
  value: T,
  onCancel: () => void
): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.enqueue(value);
    },
    cancel() {
      onCancel();
    }
  });
}

async function expectClosesAfterCleanup(
  cleanup: (subscription: StreamSubscriptionRPC<string>) => Promise<void> | void
): Promise<void> {
  const sourceCancel = vi.fn();
  const subscription = new StreamSubscriptionRPC(
    cancellableSource('first', sourceCancel)
  );
  const stream = await subscription.stream();
  const reader = stream.getReader();

  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: 'first'
  });
  await cleanup(subscription);
  await expect(reader.read()).resolves.toMatchObject({ done: true });
  expect(sourceCancel).toHaveBeenCalledTimes(1);
}

describe('StreamSubscriptionRPC', () => {
  it('cancels the owned source exactly once after data then dispose', async () => {
    await expectClosesAfterCleanup(async (subscription) => {
      await subscription.cancel();
      subscription[Symbol.dispose]();
    });
  });

  it('cancels the owned source exactly once when disposed before explicit cancel', async () => {
    await expectClosesAfterCleanup(async (subscription) => {
      subscription[Symbol.dispose]();
      await subscription.cancel();
    });
  });

  it('deduplicates concurrent explicit cancel calls', async () => {
    await expectClosesAfterCleanup(async (subscription) => {
      await Promise.all([
        subscription.cancel(),
        subscription.cancel(),
        subscription.cancel()
      ]);
    });
  });

  it('rejects attempts to open the subscription stream more than once', async () => {
    const subscription = new StreamSubscriptionRPC(
      new ReadableStream<string>()
    );
    await subscription.stream();
    await expect(subscription.stream()).rejects.toThrow(
      'Subscription stream already opened'
    );
    subscription[Symbol.dispose]();
  });

  it('releases the owned source lock exactly once when reads reject', async () => {
    let sourceController!: ReadableStreamDefaultController<string>;
    const source = new ReadableStream<string>({
      start(controller) {
        sourceController = controller;
      }
    });
    const subscription = new StreamSubscriptionRPC(source);
    expect(source.locked).toBe(true);
    const stream = await subscription.stream();
    const reader = stream.getReader();
    const sourceError = new Error('source failed');

    sourceController.error(sourceError);

    await expect(reader.read()).rejects.toBe(sourceError);
    expect(source.locked).toBe(false);
    await expect(subscription.cancel()).resolves.toBeUndefined();
    subscription[Symbol.dispose]();
  });
});
