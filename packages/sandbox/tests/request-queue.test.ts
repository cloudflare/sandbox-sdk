import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QueueFullError,
  QueueTimeoutError,
  RequestQueue
} from '../src/clients/request-queue';

describe('RequestQueue', () => {
  let queue: RequestQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new RequestQueue({
      maxConcurrent: 2,
      maxQueueSize: 3,
      queueTimeout: 5_000
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should have correct initial stats', () => {
      const stats = queue.getStats();
      expect(stats.activeCount).toBe(0);
      expect(stats.queueLength).toBe(0);
      expect(stats.maxConcurrent).toBe(2);
      expect(stats.maxQueueSize).toBe(3);
    });

    it('should have capacity when empty', () => {
      expect(queue.hasCapacity()).toBe(true);
    });
  });

  describe('basic execution', () => {
    it('should execute requests immediately when under concurrency limit', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      const result = await queue.execute(fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalled();
    });

    it('should track active count during execution', async () => {
      let activeCountDuringExecution = -1;

      const fn = vi.fn().mockImplementation(async () => {
        activeCountDuringExecution = queue.getStats().activeCount;
        return 'result';
      });

      await queue.execute(fn);

      expect(activeCountDuringExecution).toBe(1);
      expect(queue.getStats().activeCount).toBe(0);
    });

    it('should allow concurrent requests up to limit', async () => {
      const results: string[] = [];
      const resolvers: Array<(value: string) => void> = [];

      // Start 2 concurrent requests (at limit)
      const request1 = queue.execute(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
          })
      );
      const request2 = queue.execute(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
          })
      );

      // Both should be executing
      expect(queue.getStats().activeCount).toBe(2);
      expect(queue.getStats().queueLength).toBe(0);

      // Resolve both
      resolvers[0]('result1');
      resolvers[1]('result2');

      results.push(await request1);
      results.push(await request2);

      expect(results).toEqual(['result1', 'result2']);
    });
  });

  describe('queueing behavior', () => {
    it('should queue requests when at concurrency limit', async () => {
      const resolvers: Array<(value: string) => void> = [];

      // Fill up concurrent slots
      queue.execute(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
          })
      );
      queue.execute(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
          })
      );

      // This should be queued
      const queued = queue.execute(() => Promise.resolve('queued'));

      expect(queue.getStats().activeCount).toBe(2);
      expect(queue.getStats().queueLength).toBe(1);

      // Resolve one active request
      resolvers[0]('first');

      // Allow queued request to process
      await vi.advanceTimersByTimeAsync(0);

      const result = await queued;
      expect(result).toBe('queued');
    });

    it('should process queue in FIFO order', async () => {
      const results: number[] = [];
      const resolvers: Array<(value: number) => void> = [];

      // Fill concurrent slots
      const active1 = queue.execute(
        () =>
          new Promise<number>((resolve) => {
            resolvers.push(resolve);
          })
      );
      const active2 = queue.execute(
        () =>
          new Promise<number>((resolve) => {
            resolvers.push(resolve);
          })
      );

      // Queue additional requests
      const queued1 = queue.execute(async () => {
        results.push(1);
        return 1;
      });
      const queued2 = queue.execute(async () => {
        results.push(2);
        return 2;
      });
      const queued3 = queue.execute(async () => {
        results.push(3);
        return 3;
      });

      // Resolve active requests
      resolvers[0](0);
      resolvers[1](0);

      await active1;
      await active2;
      await vi.advanceTimersByTimeAsync(0);
      await queued1;
      await vi.advanceTimersByTimeAsync(0);
      await queued2;
      await vi.advanceTimersByTimeAsync(0);
      await queued3;

      expect(results).toEqual([1, 2, 3]);
    });

    it('should notify when requests are queued', async () => {
      const onQueued = vi.fn();
      queue = new RequestQueue({
        maxConcurrent: 1,
        maxQueueSize: 5,
        onQueued
      });

      const resolver: { resolve?: () => void } = {};

      // Fill concurrent slot
      queue.execute(
        () =>
          new Promise<void>((resolve) => {
            resolver.resolve = resolve;
          })
      );

      // Queue a request
      queue.execute(() => Promise.resolve());

      expect(onQueued).toHaveBeenCalledWith(1);

      // Cleanup
      resolver.resolve?.();
    });

    it('should notify when requests are dequeued with wait time', async () => {
      const onDequeued = vi.fn();
      queue = new RequestQueue({
        maxConcurrent: 1,
        maxQueueSize: 5,
        queueTimeout: 30_000,
        onDequeued
      });

      const resolver: { resolve?: () => void } = {};

      // Fill concurrent slot
      queue.execute(
        () =>
          new Promise<void>((resolve) => {
            resolver.resolve = resolve;
          })
      );

      // Queue a request
      const queued = queue.execute(() => Promise.resolve());

      // Wait some time
      vi.advanceTimersByTime(1_000);

      // Release the active slot
      resolver.resolve?.();

      await vi.advanceTimersByTimeAsync(0);
      await queued;

      expect(onDequeued).toHaveBeenCalled();
      expect(onDequeued.mock.calls[0][0]).toBeGreaterThanOrEqual(1_000);
    });
  });

  describe('queue limits', () => {
    it('should throw QueueFullError when queue is full', async () => {
      const resolvers: Array<() => void> = [];

      // Fill concurrent slots
      queue.execute(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          })
      );
      queue.execute(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          })
      );

      // Fill queue
      queue.execute(() => Promise.resolve());
      queue.execute(() => Promise.resolve());
      queue.execute(() => Promise.resolve());

      expect(queue.getStats().queueLength).toBe(3);

      // This should throw (queue is full)
      await expect(queue.execute(() => Promise.resolve())).rejects.toThrow(
        QueueFullError
      );

      // Cleanup
      for (const r of resolvers) {
        r();
      }
    });

    it('should include queue size in QueueFullError', () => {
      // Fill concurrent slots
      queue.execute(() => new Promise(() => {}));
      queue.execute(() => new Promise(() => {}));

      // Fill queue
      queue.execute(() => Promise.resolve());
      queue.execute(() => Promise.resolve());
      queue.execute(() => Promise.resolve());

      try {
        queue.execute(() => Promise.resolve());
      } catch (error) {
        expect(error).toBeInstanceOf(QueueFullError);
        expect((error as QueueFullError).queueSize).toBe(3);
      }
    });
  });

  describe('queue timeout', () => {
    it('should timeout queued requests after queueTimeout', async () => {
      const resolver: { resolve?: () => void } = {};

      // Fill concurrent slots
      queue.execute(
        () =>
          new Promise<void>((resolve) => {
            resolver.resolve = resolve;
          })
      );
      queue.execute(() => new Promise(() => {}));

      // Queue a request
      const queuedPromise = queue.execute(() => Promise.resolve('result'));

      // Advance past timeout
      vi.advanceTimersByTime(6_000);

      await expect(queuedPromise).rejects.toThrow(QueueTimeoutError);
    });

    it('should include wait time in QueueTimeoutError', async () => {
      // Fill concurrent slots
      queue.execute(() => new Promise(() => {}));
      queue.execute(() => new Promise(() => {}));

      // Queue a request
      const queuedPromise = queue.execute(() => Promise.resolve());

      // Advance past timeout
      vi.advanceTimersByTime(6_000);

      try {
        await queuedPromise;
      } catch (error) {
        expect(error).toBeInstanceOf(QueueTimeoutError);
        expect((error as QueueTimeoutError).waitTime).toBeGreaterThanOrEqual(
          5_000
        );
      }
    });

    it('should remove timed-out requests from queue', async () => {
      // Fill concurrent slots
      queue.execute(() => new Promise(() => {}));
      queue.execute(() => new Promise(() => {}));

      // Queue requests with different timeouts by using a longer timeout queue
      const longTimeoutQueue = new RequestQueue({
        maxConcurrent: 2,
        maxQueueSize: 5,
        queueTimeout: 10_000 // Longer timeout
      });

      // Fill concurrent slots
      longTimeoutQueue.execute(() => new Promise(() => {}));
      longTimeoutQueue.execute(() => new Promise(() => {}));

      // Queue two requests
      const queued1 = longTimeoutQueue.execute(() => Promise.resolve(1));
      longTimeoutQueue.execute(() => Promise.resolve(2));

      expect(longTimeoutQueue.getStats().queueLength).toBe(2);

      // Timeout all requests (advance past the 10s timeout)
      vi.advanceTimersByTime(11_000);

      // Both should have timed out
      await expect(queued1).rejects.toThrow(QueueTimeoutError);

      // Both requests should have been removed
      expect(longTimeoutQueue.getStats().queueLength).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should propagate errors from executed functions', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('execution failed'));

      await expect(queue.execute(fn)).rejects.toThrow('execution failed');
    });

    it('should decrement active count on error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      try {
        await queue.execute(fn);
      } catch {
        // Expected
      }

      expect(queue.getStats().activeCount).toBe(0);
    });

    it('should process queue after error in active request', async () => {
      let resolver: { resolve?: () => void } = {};

      // Fill one slot with a request that will fail
      const failing = queue.execute(
        () =>
          new Promise<void>((_, reject) => {
            resolver = { resolve: () => reject(new Error('fail')) };
          })
      );

      // Fill another slot
      queue.execute(() => new Promise(() => {}));

      // Queue a request
      const queued = queue.execute(() => Promise.resolve('queued result'));

      // Fail the first request
      resolver.resolve?.();

      try {
        await failing;
      } catch {
        // Expected
      }

      await vi.advanceTimersByTimeAsync(0);

      const result = await queued;
      expect(result).toBe('queued result');
    });
  });

  describe('clear', () => {
    it('should clear all queued requests', async () => {
      // Fill concurrent slots
      queue.execute(() => new Promise(() => {}));
      queue.execute(() => new Promise(() => {}));

      // Queue requests
      const queued1 = queue.execute(() => Promise.resolve());
      const queued2 = queue.execute(() => Promise.resolve());

      expect(queue.getStats().queueLength).toBe(2);

      queue.clear('Test clear');

      expect(queue.getStats().queueLength).toBe(0);

      await expect(queued1).rejects.toThrow('Test clear');
      await expect(queued2).rejects.toThrow('Test clear');
    });

    it('should not affect active requests when clearing', async () => {
      const resolver: { resolve?: (value: string) => void } = {};

      // Start an active request
      const active = queue.execute(
        () =>
          new Promise<string>((resolve) => {
            resolver.resolve = resolve;
          })
      );

      // Queue a request
      queue.execute(() => Promise.resolve());

      queue.clear();

      // Active request should still complete
      resolver.resolve?.('active result');

      const result = await active;
      expect(result).toBe('active result');
    });
  });

  describe('hasCapacity', () => {
    it('should return true when under limits', () => {
      expect(queue.hasCapacity()).toBe(true);
    });

    it('should return true when at concurrency limit but queue has space', () => {
      // Fill concurrent slots
      queue.execute(() => new Promise(() => {}));
      queue.execute(() => new Promise(() => {}));

      expect(queue.hasCapacity()).toBe(true);
    });

    it('should return false when queue is full', () => {
      // Fill concurrent slots
      queue.execute(() => new Promise(() => {}));
      queue.execute(() => new Promise(() => {}));

      // Fill queue
      queue.execute(() => Promise.resolve());
      queue.execute(() => Promise.resolve());
      queue.execute(() => Promise.resolve());

      expect(queue.hasCapacity()).toBe(false);
    });
  });

  describe('default options', () => {
    it('should use sensible defaults', () => {
      const defaultQueue = new RequestQueue();
      const stats = defaultQueue.getStats();

      expect(stats.maxConcurrent).toBe(10);
      expect(stats.maxQueueSize).toBe(100);
    });
  });
});
