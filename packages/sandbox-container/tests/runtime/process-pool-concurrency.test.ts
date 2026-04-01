/**
 * Regression tests for issue #276: parallel code context ops crash container.
 *
 * reserveExecutorForContext() holds the per-language mutex while spawning child
 * processes (~300-500ms), serializing parallel context creation. These tests mock
 * createProcess with a controlled delay and assert parallel completion time.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createNoOpLogger } from '@repo/shared';
import {
  type InterpreterLanguage,
  type InterpreterProcess,
  ProcessPoolManager
} from '../../src/runtime/process-pool';

let mockIdCounter = 0;

function createMockChildProcess() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid: ++mockIdCounter,
    killed: false,
    exitCode: null as number | null,
    signalCode: null,
    connected: false,
    stdin: null,
    stdout: null,
    stderr: null,
    stdio: [null, null, null, null, null],
    kill() {
      this.killed = true;
      return true;
    },
    send: () => true,
    disconnect: () => {},
    ref: () => emitter,
    unref: () => emitter
  });
}

/**
 * Creates a ProcessPoolManager with minSize: 0 (skips pre-warming) and replaces
 * the private createProcess with a mock that sleeps for `spawnDelayMs`. Returns
 * a tracker recording spawn start/end timestamps for concurrency assertions.
 *
 * Uses env var overrides because the config parser treats `0 || defaultMinSize`
 * as falsy, falling through to default (3). Env vars take a separate code path.
 */
function createTestPool(
  spawnDelayMs: number,
  opts?: { maxProcesses?: number }
) {
  const envKeys = [
    'JAVASCRIPT_POOL_MIN_SIZE',
    'PYTHON_POOL_MIN_SIZE',
    'TYPESCRIPT_POOL_MIN_SIZE'
  ] as const;
  const maxEnvKeys = [
    'JAVASCRIPT_POOL_MAX_SIZE',
    'PYTHON_POOL_MAX_SIZE',
    'TYPESCRIPT_POOL_MAX_SIZE'
  ] as const;
  const allKeys = [...envKeys, ...maxEnvKeys];
  const saved = allKeys.map((k) => process.env[k]);

  for (const k of envKeys) process.env[k] = '0';
  if (opts?.maxProcesses !== undefined) {
    for (const k of maxEnvKeys) process.env[k] = String(opts.maxProcesses);
  }

  const pool = new ProcessPoolManager({}, createNoOpLogger());

  for (let i = 0; i < allKeys.length; i++) {
    if (saved[i] === undefined) delete process.env[allKeys[i]];
    else process.env[allKeys[i]] = saved[i];
  }

  const tracker = {
    spawnCount: 0,
    spawnStarts: [] as number[],
    spawnEnds: [] as number[]
  };

  (pool as any).createProcess = async (
    language: InterpreterLanguage,
    sessionId?: string
  ): Promise<InterpreterProcess> => {
    const id = `mock-${++mockIdCounter}`;
    tracker.spawnCount++;
    tracker.spawnStarts.push(Date.now());

    await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));

    tracker.spawnEnds.push(Date.now());

    const mockProcess = createMockChildProcess();
    const executor: InterpreterProcess = {
      id,
      language,
      process: mockProcess as any,
      sessionId,
      lastUsed: new Date()
    };

    (pool as any).executorLocks.set(
      id,
      new (await import('async-mutex')).Mutex()
    );

    return executor;
  };

  return { pool, tracker };
}

async function prePopulatePool(
  pool: ProcessPoolManager,
  language: InterpreterLanguage,
  count: number
) {
  const { Mutex } = await import('async-mutex');
  const available: InterpreterProcess[] = [];
  for (let i = 0; i < count; i++) {
    const executor: InterpreterProcess = {
      id: `pre-warmed-${language}-${i}`,
      language,
      process: createMockChildProcess() as any,
      lastUsed: new Date()
    };
    available.push(executor);
    (pool as any).pools.get(language)!.push(executor);
    (pool as any).executorLocks.set(executor.id, new Mutex());
  }
  (pool as any).availableExecutors.set(language, available);
}

describe('ProcessPoolManager concurrency (issue #276)', () => {
  let pool: ProcessPoolManager;
  let tracker: ReturnType<typeof createTestPool>['tracker'];

  afterEach(async () => {
    if (pool) await pool.shutdown();
  });

  describe('reserveExecutorForContext parallelism', () => {
    it('should spawn processes concurrently without staircasing', async () => {
      const SPAWN_DELAY = 100;
      const PARALLEL = 6;
      ({ pool, tracker } = createTestPool(SPAWN_DELAY));

      const start = Date.now();
      await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          pool.reserveExecutorForContext(`ctx-${i}`, 'javascript')
        )
      );
      const elapsed = Date.now() - start;

      expect(tracker.spawnCount).toBe(PARALLEL);
      expect(elapsed).toBeLessThan(SPAWN_DELAY * 2);

      const startSpread =
        Math.max(...tracker.spawnStarts) - Math.min(...tracker.spawnStarts);
      expect(startSpread).toBeLessThan(SPAWN_DELAY / 2);
    });
  });

  describe('fast path (pre-warmed executors)', () => {
    it('should assign available executors without spawning', async () => {
      const SPAWN_DELAY = 100;
      ({ pool, tracker } = createTestPool(SPAWN_DELAY));
      await prePopulatePool(pool, 'javascript', 3);

      const start = Date.now();
      await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          pool.reserveExecutorForContext(`fast-ctx-${i}`, 'javascript')
        )
      );
      const elapsed = Date.now() - start;

      expect(tracker.spawnCount).toBe(0);
      expect(elapsed).toBeLessThan(SPAWN_DELAY / 2);
    });

    it('should use pool for first N then spawn the rest in parallel', async () => {
      const SPAWN_DELAY = 100;
      const PRE_WARMED = 3;
      const TOTAL = 6;
      ({ pool, tracker } = createTestPool(SPAWN_DELAY));
      await prePopulatePool(pool, 'javascript', PRE_WARMED);

      const start = Date.now();
      await Promise.all(
        Array.from({ length: TOTAL }, (_, i) =>
          pool.reserveExecutorForContext(`mixed-ctx-${i}`, 'javascript')
        )
      );
      const elapsed = Date.now() - start;

      expect(tracker.spawnCount).toBe(TOTAL - PRE_WARMED);
      // 3 spawns in parallel ≈ 1 spawn cycle, not 3 serial cycles.
      expect(elapsed).toBeLessThan(SPAWN_DELAY * 2);
    });
  });

  describe('correctness under parallel reservation', () => {
    it('should assign a unique executor to each context', async () => {
      const PARALLEL = 6;
      ({ pool, tracker } = createTestPool(50));

      const contextIds = Array.from(
        { length: PARALLEL },
        (_, i) => `unique-ctx-${i}`
      );

      await Promise.all(
        contextIds.map((id) => pool.reserveExecutorForContext(id, 'javascript'))
      );

      const executorIds = new Set<string>();
      for (const ctxId of contextIds) {
        const executor = pool.getExecutorForContext(ctxId);
        expect(executor).toBeDefined();
        expect(executor!.sessionId).toBe(ctxId);
        executorIds.add(executor!.id);
      }

      expect(executorIds.size).toBe(PARALLEL);
    });

    it('should not let JS contexts block Python contexts', async () => {
      const SPAWN_DELAY = 100;
      ({ pool, tracker } = createTestPool(SPAWN_DELAY));

      const start = Date.now();
      await Promise.all([
        pool.reserveExecutorForContext('js-ctx-1', 'javascript'),
        pool.reserveExecutorForContext('js-ctx-2', 'javascript'),
        pool.reserveExecutorForContext('py-ctx-1', 'python'),
        pool.reserveExecutorForContext('py-ctx-2', 'python')
      ]);
      const elapsed = Date.now() - start;

      expect(tracker.spawnCount).toBe(4);
      // Cross-language uses separate mutexes: 2 JS + 2 Python run as 2
      // independent serial chains in parallel ≈ 2 × delay. After fix ≈ 1 × delay.
      expect(elapsed).toBeLessThan(SPAWN_DELAY * 3);

      expect(pool.getExecutorForContext('js-ctx-1')?.language).toBe(
        'javascript'
      );
      expect(pool.getExecutorForContext('py-ctx-1')?.language).toBe('python');
    });
  });

  describe('maxProcesses enforcement', () => {
    it('should allow exactly maxProcesses parallel spawns', async () => {
      const MAX = 4;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      await Promise.all(
        Array.from({ length: MAX }, (_, i) =>
          pool.reserveExecutorForContext(`ctx-${i}`, 'javascript')
        )
      );

      expect(tracker.spawnCount).toBe(MAX);
    });

    it('should reject the (maxProcesses + 1)th spawn', async () => {
      const MAX = 3;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      const results = await Promise.allSettled(
        Array.from({ length: MAX + 1 }, (_, i) =>
          pool.reserveExecutorForContext(`ctx-${i}`, 'javascript')
        )
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(MAX);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
        'Maximum'
      );
    });

    it('should free a permit when a context is released', async () => {
      const MAX = 3;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      await Promise.all(
        Array.from({ length: MAX }, (_, i) =>
          pool.reserveExecutorForContext(`ctx-${i}`, 'javascript')
        )
      );

      // At limit — next one should fail
      await expect(
        pool.reserveExecutorForContext('blocked', 'javascript')
      ).rejects.toThrow('Maximum');

      // Release one context
      await pool.releaseExecutorForContext('ctx-0', 'javascript');

      // Now a new one should succeed
      await pool.reserveExecutorForContext('replacement', 'javascript');
      expect(pool.getExecutorForContext('replacement')).toBeDefined();
      expect(tracker.spawnCount).toBe(MAX + 1);
    });

    it('should release permit when spawn fails', async () => {
      const MAX = 2;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      // Make the next createProcess call fail
      let callCount = 0;
      const originalCreate = (pool as any).createProcess.bind(pool);
      (pool as any).createProcess = async (...args: any[]) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Simulated spawn failure');
        }
        return originalCreate(...args);
      };

      // First succeeds, second fails
      const results = await Promise.allSettled([
        pool.reserveExecutorForContext('ok-ctx', 'javascript'),
        pool.reserveExecutorForContext('fail-ctx', 'javascript')
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');

      // The failed spawn should have released its permit, so this should work
      await pool.reserveExecutorForContext('after-failure', 'javascript');
      expect(pool.getExecutorForContext('after-failure')).toBeDefined();
    });
  });

  describe('semaphore permit accounting', () => {
    it('releasing one context should free exactly one permit, not two', async () => {
      const MAX = 3;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      await Promise.all(
        Array.from({ length: MAX }, (_, i) =>
          pool.reserveExecutorForContext(`ctx-${i}`, 'javascript')
        )
      );

      await pool.releaseExecutorForContext('ctx-0', 'javascript');
      await pool.reserveExecutorForContext('new-ctx', 'javascript');

      await expect(
        pool.reserveExecutorForContext('overcounted', 'javascript')
      ).rejects.toThrow('Maximum');
    });

    it('full create-delete cycle should restore exactly maxProcesses permits', async () => {
      const MAX = 3;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      await Promise.all(
        Array.from({ length: MAX }, (_, i) =>
          pool.reserveExecutorForContext(`cycle1-${i}`, 'javascript')
        )
      );

      for (let i = 0; i < MAX; i++) {
        await pool.releaseExecutorForContext(`cycle1-${i}`, 'javascript');
      }

      await Promise.all(
        Array.from({ length: MAX }, (_, i) =>
          pool.reserveExecutorForContext(`cycle2-${i}`, 'javascript')
        )
      );

      await expect(
        pool.reserveExecutorForContext('over-limit', 'javascript')
      ).rejects.toThrow('Maximum');
    });
  });

  describe('dead process detection before registration', () => {
    it('should reject when process exits with non-zero code before registration', async () => {
      const MAX = 3;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      const originalCreate = (pool as any).createProcess.bind(pool);
      (pool as any).createProcess = async (...args: any[]) => {
        const executor = await originalCreate(...args);
        executor.process.exitCode = 1;
        return executor;
      };

      await expect(
        pool.reserveExecutorForContext('dead-ctx', 'javascript')
      ).rejects.toThrow('Process exited before registration');
    });

    it('should not leak a permit when dead process is detected', async () => {
      const MAX = 2;
      ({ pool, tracker } = createTestPool(50, { maxProcesses: MAX }));

      let shouldDie = true;
      const originalCreate = (pool as any).createProcess.bind(pool);
      (pool as any).createProcess = async (...args: any[]) => {
        const executor = await originalCreate(...args);
        if (shouldDie) {
          executor.process.exitCode = 1;
          shouldDie = false;
        }
        return executor;
      };

      await expect(
        pool.reserveExecutorForContext('dead-ctx', 'javascript')
      ).rejects.toThrow('Process exited before registration');

      await pool.reserveExecutorForContext('alive-ctx-1', 'javascript');
      await pool.reserveExecutorForContext('alive-ctx-2', 'javascript');

      await expect(
        pool.reserveExecutorForContext('over-limit', 'javascript')
      ).rejects.toThrow('Maximum');
    });
  });
});
