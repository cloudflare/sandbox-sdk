import { describe, expect, test, vi } from 'vitest';
import type { ContainerControlClient } from '../../src/container-control/client';
import { ErrorCode, OperationInterruptedError } from '../../src/errors';
import { ResourceActivityGate } from '../../src/resource-activity-gate';
import type {
  RuntimeConnectionHold,
  RuntimeIncarnationID
} from '../../src/runtime';
import { RuntimeIdentity, RuntimeOperationRunner } from '../../src/runtime';
import type { RuntimeSession } from '../../src/runtime/types';
import {
  type RuntimeIdentityID,
  RuntimeIdentityInactiveError
} from '../../src/runtime/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runtime(id = 'runtime', incarnation = 'incarnation') {
  return new RuntimeIdentity({
    id: id as RuntimeIdentityID,
    runtimeIncarnationID: incarnation as RuntimeIncarnationID
  });
}

class FakeSession implements RuntimeSession {
  readonly client = {} as ContainerControlClient;
  private poisoned = false;
  private rejectInterrupted!: (error: Error) => void;
  readonly interrupted = new Promise<never>((_, reject) => {
    this.rejectInterrupted = reject;
  });
  readonly holds = new Set<RuntimeConnectionHold>();
  readonly interruptCallbacks = new Map<RuntimeConnectionHold, () => void>();

  constructor() {
    this.interrupted.catch(() => undefined);
  }

  isInterrupted(): boolean {
    return this.poisoned;
  }

  retain(onInterrupt?: () => void): RuntimeConnectionHold {
    if (this.poisoned) {
      onInterrupt?.();
      return { release: () => {} };
    }
    const hold = {
      release: vi.fn(() => {
        this.holds.delete(hold);
        this.interruptCallbacks.delete(hold);
      })
    };
    this.holds.add(hold);
    if (onInterrupt) this.interruptCallbacks.set(hold, onInterrupt);
    return hold;
  }

  interrupt(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.rejectInterrupted(new Error('closed'));
    for (const hold of [...this.holds]) {
      this.interruptCallbacks.get(hold)?.();
      hold.release();
    }
  }
}

function setup(current = runtime()) {
  const renew = vi.fn();
  const stop = vi.fn(async () => undefined);
  const gate = new ResourceActivityGate(renew, stop);
  const listeners = new Set<() => void>();
  const session = new FakeSession();
  let active: RuntimeIdentity | null = current;
  let establishCalls = 0;
  let acquireCalls = 0;
  const lifecycle = {
    sessions: {
      acquireSession: vi.fn(async () => {
        acquireCalls += 1;
        return session;
      })
    },
    establish: vi.fn(async () => {
      establishCalls += 1;
      active = current;
      return current;
    }),
    get: vi.fn(async () => active),
    isActive: vi.fn(async (expected: RuntimeIdentity) =>
      same(active, expected)
    ),
    assertActive: vi.fn(async (expected: RuntimeIdentity) => {
      if (!same(active, expected)) throw new Error('inactive');
    }),
    onChange: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    replace(next: RuntimeIdentity | null) {
      active = next;
      session.interrupt();
      for (const listener of [...listeners]) listener();
    }
  };
  const runner = new RuntimeOperationRunner({
    lifecycle: lifecycle as never,
    activityGate: gate
  });
  return {
    runner,
    lifecycle,
    gate,
    renew,
    stop,
    session,
    get establishCalls() {
      return establishCalls;
    },
    get acquireCalls() {
      return acquireCalls;
    },
    get listenerCount() {
      return listeners.size;
    }
  };
}

describe('RuntimeOperationRunner', () => {
  test('runWaking admits once after establishment and renews once', async () => {
    const ctx = setup();
    const dispatch = vi.fn(async (lease) => lease.runtime.id);

    await ctx.runner.runWaking('files.read', dispatch);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ctx.establishCalls).toBe(1);
    expect(ctx.acquireCalls).toBe(1);
    expect(ctx.renew).toHaveBeenCalledTimes(2);
  });

  test('replacement during waking establishment is a uniform interruption', async () => {
    const ctx = setup();
    ctx.lifecycle.establish.mockRejectedValueOnce(
      new RuntimeIdentityInactiveError()
    );
    const dispatch = vi.fn(async () => 'forwarded');

    await expect(
      ctx.runner.runWaking('container.fetch', dispatch)
    ).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      context: { operation: 'container.fetch', retryable: false }
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.acquireCalls).toBe(0);
  });

  test('runExisting and probeExisting never establish', async () => {
    const ctx = setup();
    await ctx.runner.runExisting(
      { kind: 'current' },
      'process.list',
      async () => 'ok'
    );
    await ctx.runner.probeExisting(
      { kind: 'current' },
      'expiry.probe',
      async () => 'ok'
    );
    expect(ctx.establishCalls).toBe(0);
    expect(ctx.acquireCalls).toBe(2);
    expect(ctx.renew).not.toHaveBeenCalled();
  });

  test('expected runtime mismatch returns absent before dispatch', async () => {
    const ctx = setup(runtime('current', 'one'));
    const dispatch = vi.fn(async () => 'dispatched');
    const result = await ctx.runner.runExisting(
      { kind: 'runtime', runtime: runtime('old', 'one') },
      'process.get',
      dispatch
    );
    expect(result).toEqual({ status: 'absent' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.acquireCalls).toBe(0);
  });

  test('replacement between lookup and session acquisition interrupts before dispatch', async () => {
    const current = runtime('current', 'one');
    const ctx = setup(current);
    const dispatch = vi.fn(async () => 'dispatched');
    ctx.lifecycle.sessions.acquireSession.mockImplementationOnce(async () => {
      ctx.lifecycle.replace(runtime('next', 'two'));
      return ctx.session;
    });
    await expect(
      ctx.runner.runExisting({ kind: 'current' }, 'race.operation', dispatch)
    ).rejects.toMatchObject({ name: 'OperationInterruptedError' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.listenerCount).toBe(0);
  });

  test('preserves structured interruption while the runtime stays active', async () => {
    const ctx = setup(runtime('current', 'one'));
    const interruption = new OperationInterruptedError({
      code: ErrorCode.OPERATION_INTERRUPTED,
      message: 'Sandbox lifetime changed',
      httpStatus: 409,
      context: {
        reason: 'sandbox_lifetime_changed',
        operation: 'backup.restore',
        admitted: true,
        retryable: false
      },
      timestamp: '2026-06-15T12:00:00.000Z'
    });

    await expect(
      ctx.runner.runWaking('backup.restore', async () => {
        throw interruption;
      })
    ).rejects.toBe(interruption);
    expect(ctx.listenerCount).toBe(0);
  });

  test('post replacement throws uniform OperationInterruptedError', async () => {
    const ctx = setup(runtime('current', 'one'));
    await expect(
      ctx.runner.runExisting({ kind: 'current' }, 'label.only', async () => {
        ctx.lifecycle.replace(runtime('next', 'two'));
        return 'stale';
      })
    ).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      context: { operation: 'label.only', retryable: false }
    });
    expect(ctx.listenerCount).toBe(0);
  });

  test('retained waking holds extend activity until last release with a real gate', async () => {
    const ctx = setup();
    let first!: RuntimeConnectionHold;
    let second!: RuntimeConnectionHold;
    await ctx.runner.runWaking('stream.open', async (lease) => {
      first = lease.retain();
      second = lease.retain();
      return 'ok';
    });

    await ctx.gate.runExpiry(activeProbe(false), false);
    expect(ctx.stop).not.toHaveBeenCalled();

    first.release();
    first.release();
    await ctx.gate.runExpiry(activeProbe(false), false);
    expect(ctx.stop).not.toHaveBeenCalled();

    second.release();
    await ctx.gate.runExpiry(activeProbe(false), false);
    expect(ctx.stop).toHaveBeenCalledTimes(1);
  });

  test('retained existing holds block committed expiry until last release', async () => {
    const ctx = setup();
    let hold!: RuntimeConnectionHold;
    await ctx.runner.runExisting(
      { kind: 'current' },
      'watch.open',
      async (lease) => {
        hold = lease.retain();
        return 'ok';
      }
    );
    await ctx.gate.runExpiry(activeProbe(false), false);
    expect(ctx.stop).not.toHaveBeenCalled();
    hold.release();
    await ctx.gate.runExpiry(activeProbe(false), false);
    expect(ctx.stop).toHaveBeenCalledTimes(1);
  });

  test('session interruption wins and late retain cannot leak after callback continues', async () => {
    const ctx = setup(runtime('current', 'one'));
    const continueCallback = deferred<void>();
    const lateRejection = new Error('late callback failure');
    const call = ctx.runner.runExisting(
      { kind: 'current' },
      'rpc.late',
      async (lease) => {
        await continueCallback.promise;
        lease.retain().release();
        throw lateRejection;
      }
    );
    await vi.waitFor(() => expect(ctx.session.holds.size).toBe(1));
    ctx.lifecycle.replace(runtime('next', 'two'));

    await expect(call).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      context: { operation: 'rpc.late' }
    });
    continueCallback.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await ctx.gate.runExpiry(activeProbe(false), false);

    expect(ctx.session.holds.size).toBe(0);
    expect(ctx.stop).toHaveBeenCalledTimes(1);
    expect(ctx.listenerCount).toBe(0);
  });

  test('session interruption fanout rejects in-flight RPC and releases retained activity', async () => {
    const ctx = setup(runtime('current', 'one'));
    let retained!: RuntimeConnectionHold;
    const pending = deferred<string>();
    const call = ctx.runner.runExisting(
      { kind: 'current' },
      'rpc.wait',
      async (lease) => {
        retained = lease.retain();
        return pending.promise;
      }
    );
    await vi.waitFor(() => expect(ctx.session.holds.size).toBe(2));
    ctx.lifecycle.replace(runtime('next', 'two'));

    await expect(call).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      context: { operation: 'rpc.wait' }
    });
    retained.release();
    await ctx.gate.runExpiry(activeProbe(false), false);
    expect(ctx.stop).toHaveBeenCalledTimes(1);
    expect(ctx.session.holds.size).toBe(0);
    expect(ctx.listenerCount).toBe(0);
  });
});

function activeProbe(processesActive: boolean) {
  return {
    availability: async () => 'available' as const,
    processesHasActive: async () => processesActive,
    terminalsHasActive: async () => false
  };
}

function same(left: RuntimeIdentity | null, right: RuntimeIdentity): boolean {
  return (
    left?.id === right.id &&
    left.runtimeIncarnationID === right.runtimeIncarnationID
  );
}
