import type { RuntimeMetadata } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerControlClient } from '../../src/container-control/client';
import type { RuntimeIdentityID } from '../../src/current-runtime-identity';
import {
  RuntimeIdentity,
  type RuntimeIncarnationID,
  type RuntimeRecord,
  SandboxRuntimeLifecycle
} from '../../src/runtime';

type Stored = RuntimeRecord | { id: RuntimeIdentityID } | undefined;
type FailurePoint =
  | 'start'
  | 'wait'
  | 'probe'
  | 'acquire'
  | 'compat'
  | 'reconcile'
  | 'put';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MemoryStorage {
  value: Stored;
  failPut = false;
  calls?: string[];
  deferredPut?: ReturnType<typeof deferred<void>>;
  deferredPutAfterVisible?: ReturnType<typeof deferred<void>>;
  deferredGetAfterRead?: ReturnType<typeof deferred<void>>;

  async get<T>(): Promise<T | undefined> {
    const value = this.value as T | undefined;
    if (this.deferredGetAfterRead) await this.deferredGetAfterRead.promise;
    return value;
  }
  async put<T>(key: string, value: T): Promise<void>;
  async put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(
    keyOrEntries: string | Record<string, T>,
    value?: T
  ): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.calls?.push('put');
      if (this.failPut) throw new Error('put failed');
      if (this.deferredPut) await this.deferredPut.promise;
      this.value = value as Stored;
      if (this.deferredPutAfterVisible)
        await this.deferredPutAfterVisible.promise;
    }
  }
  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    this.value = undefined;
    return Array.isArray(keyOrKeys) ? keyOrKeys.length : true;
  }
}

const metadata = (
  runtimeIncarnationID: string,
  sandboxVersion = '0.0.0'
): RuntimeMetadata => ({
  runtimeIncarnationID,
  sandboxVersion,
  controlProtocolVersion: 1
});

const runtime = (id: string, incarnation: string) =>
  new RuntimeIdentity({
    id: id as RuntimeIdentityID,
    runtimeIncarnationID: incarnation as RuntimeIncarnationID
  });

function record(identity: RuntimeIdentity): RuntimeRecord {
  return {
    schemaVersion: 1,
    id: identity.id,
    runtimeIncarnationID: identity.runtimeIncarnationID
  };
}

function host(
  options: {
    stored?: Stored;
    running?: boolean;
    incarnation?: string;
    sandboxVersion?: string;
    fail?: FailurePoint;
    deferredCompat?: ReturnType<typeof deferred<void>>;
  } = {}
) {
  const storage = new MemoryStorage();
  storage.value = options.stored;
  storage.failPut = options.fail === 'put';
  storage.calls = [];
  let running = options.running ?? false;
  const calls: string[] = [];
  const featureReplay = {
    restore: vi.fn(),
    mountLocalSync: vi.fn(),
    namedTunnelProvision: vi.fn(),
    previewActivation: vi.fn()
  };
  const sessions = {
    acquire: vi.fn(async () => {
      calls.push('acquire');
      if (options.fail === 'acquire') throw new Error('session failed');
      return {} as ContainerControlClient;
    }),
    acquireSession: vi.fn(async () => {
      throw new Error('not used by lifecycle tests');
    }),
    closeActive: vi.fn(() => {
      calls.push('closeActive');
    }),
    dispose: vi.fn(() => {
      calls.push('dispose');
    })
  };
  const lifecycleOptions = {
    storage,
    isRuntimeRunning: () => running,
    startControlPort: vi.fn(async () => {
      calls.push('start');
      if (options.fail === 'start') throw new Error('start failed');
      running = true;
    }),
    waitForControlPort: vi.fn(async () => {
      calls.push('wait');
      if (options.fail === 'wait') throw new Error('readiness failed');
    }),
    stopControlPort: vi.fn(async () => {
      calls.push('stop');
      running = false;
    }),
    probe: {
      probe: vi.fn(async () => {
        calls.push('probe');
        if (options.fail === 'probe') throw new Error('probe failed');
        return metadata(
          options.incarnation ?? 'inc-1',
          options.sandboxVersion ?? '0.0.0'
        );
      })
    },
    sessions,
    observeVersionCompatibility: vi.fn(async () => {
      calls.push('compat');
      if (options.deferredCompat) await options.deferredCompat.promise;
      if (options.fail === 'compat') throw new Error('version failed');
    }),
    reconcileReplacement: vi.fn(async () => {
      calls.push('reconcile');
      if (options.fail === 'reconcile') throw new Error('reconcile failed');
    })
  };
  const api = {
    storage,
    calls,
    featureReplay,
    sessions,
    lifecycleOptions,
    setRunning(value: boolean) {
      running = value;
    },
    lifecycle: new SandboxRuntimeLifecycle(lifecycleOptions)
  };
  storage.calls = calls;
  return api;
}

describe('SandboxRuntimeLifecycle', () => {
  it('cold concurrent establishment starts once, reconciles once, and publishes one active record', async () => {
    const h = host();

    const [first, second] = await Promise.all([
      h.lifecycle.establish(),
      h.lifecycle.establish()
    ]);

    expect(first).toBe(second);
    expect(h.calls).toEqual([
      'start',
      'wait',
      'probe',
      'acquire',
      'compat',
      'reconcile',
      'put'
    ]);
    expect(h.storage.value).toEqual(record(first));
  });

  it('reuses stored identity for the same incarnation after a non-starting handshake', async () => {
    const existing = runtime('runtime-1', 'inc-1');
    const h = host({ stored: record(existing), running: true });

    await expect(h.lifecycle.establish()).resolves.toMatchObject({
      id: existing.id,
      runtimeIncarnationID: existing.runtimeIncarnationID
    });

    expect(h.calls).toEqual(['probe', 'acquire', 'compat', 'put']);
  });

  it('creates a new identity and reconciles before publishing when incarnation changes', async () => {
    const existing = runtime('runtime-1', 'inc-old');
    const h = host({
      stored: record(existing),
      running: true,
      incarnation: 'inc-new'
    });

    const adopted = await h.lifecycle.establish();

    expect(adopted.id).not.toBe(existing.id);
    expect(adopted.runtimeIncarnationID).toBe('inc-new');
    expect(h.calls).toEqual(['probe', 'acquire', 'compat', 'reconcile', 'put']);
    expect(h.storage.value).toEqual(record(adopted));
  });

  it('adopts a running control process when no active record exists', async () => {
    const h = host({ running: true });

    const adopted = await h.lifecycle.establish();

    expect(h.calls).toEqual(['probe', 'acquire', 'compat', 'reconcile', 'put']);
    expect(h.storage.value).toEqual(record(adopted));
  });

  it('retries idempotent adoption after a crash before the active write', async () => {
    const crashed = host({ running: true, fail: 'put' });
    await expect(crashed.lifecycle.establish()).rejects.toThrow('put failed');
    expect(crashed.calls).toEqual([
      'probe',
      'acquire',
      'compat',
      'reconcile',
      'put'
    ]);
    expect(crashed.storage.value).toBeUndefined();

    const retry = host({ stored: crashed.storage.value, running: true });
    const adopted = await retry.lifecycle.establish();

    expect(retry.calls).toEqual([
      'probe',
      'acquire',
      'compat',
      'reconcile',
      'put'
    ]);
    expect(retry.storage.value).toEqual(record(adopted));
  });

  it('retries adoption after interruption after compatibility before reconciliation', async () => {
    const compat = deferred<void>();
    const first = host({ running: true, deferredCompat: compat });
    const establishing = first.lifecycle.establish();
    while (!first.calls.includes('compat')) await Promise.resolve();
    await first.lifecycle.invalidate();
    compat.resolve();

    await expect(establishing).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    expect(first.calls).not.toContain('reconcile');
    expect(first.storage.value).toBeUndefined();

    const retry = host({ running: true, incarnation: 'inc-1' });
    await retry.lifecycle.establish();

    expect(retry.calls).toEqual([
      'probe',
      'acquire',
      'compat',
      'reconcile',
      'put'
    ]);
  });

  it('fences establishment before returning cleanup authority during invalidation', async () => {
    const active = runtime('runtime-1', 'inc-1');
    const compat = deferred<void>();
    const h = host({
      stored: record(active),
      running: true,
      incarnation: 'inc-2',
      deferredCompat: compat
    });
    const establishing = h.lifecycle.establish();
    while (!h.calls.includes('compat')) await Promise.resolve();

    const invalidating = h.lifecycle.invalidateAndObserveStoredActive();
    compat.resolve();

    await expect(establishing).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    await expect(invalidating).resolves.toEqual(active);
    expect(h.storage.value).toBeUndefined();
  });

  it('retries reconciliation for the same incarnation after interrupted reconciliation', async () => {
    const first = host({ running: true, fail: 'reconcile' });
    await expect(first.lifecycle.establish()).rejects.toThrow(
      'reconcile failed'
    );
    expect(first.storage.value).toBeUndefined();

    const retry = host({ running: true, incarnation: 'inc-1' });
    await retry.lifecycle.establish();

    expect(retry.calls).toEqual([
      'probe',
      'acquire',
      'compat',
      'reconcile',
      'put'
    ]);
  });

  it('rejects legacy and empty schema records for observations', async () => {
    const cases: Stored[] = [
      { id: 'legacy' as RuntimeIdentityID },
      {
        schemaVersion: 1,
        id: '' as RuntimeIdentityID,
        runtimeIncarnationID: 'inc-1' as RuntimeIncarnationID
      },
      {
        schemaVersion: 1,
        id: 'runtime-1' as RuntimeIdentityID,
        runtimeIncarnationID: '' as RuntimeIncarnationID
      }
    ];

    for (const stored of cases) {
      const h = host({ stored, running: true });
      await expect(h.lifecycle.observeStoredActive()).resolves.toBeNull();
      await expect(h.lifecycle.get()).resolves.toBeNull();
    }
  });

  it('surfaces start, readiness, metadata, session, version, and reconciliation failures without publishing', async () => {
    const expectations: Array<[FailurePoint, string[]]> = [
      ['start', ['start']],
      ['wait', ['start', 'wait']],
      ['probe', ['probe']],
      ['acquire', ['probe', 'acquire']],
      ['compat', ['probe', 'acquire', 'compat']],
      ['reconcile', ['probe', 'acquire', 'compat', 'reconcile']]
    ];

    for (const [fail, calls] of expectations) {
      const h = host({ fail, running: !['start', 'wait'].includes(fail) });
      await expect(h.lifecycle.establish()).rejects.toThrow();
      expect(h.calls).toEqual(calls);
      expect(h.storage.value).toBeUndefined();
    }
  });

  it('rejects empty bootstrap metadata before identity selection or publish', async () => {
    for (const options of [{ incarnation: '' }, { sandboxVersion: '' }]) {
      const h = host({ running: true, ...options });

      await expect(h.lifecycle.establish()).rejects.toMatchObject({
        name: 'RuntimeControlProtocolError'
      });
      expect(h.calls).toEqual(['probe']);
      expect(h.storage.value).toBeUndefined();
    }
  });

  it('does not publish stale authority when invalidated during establishment', async () => {
    const h = host();
    const seen: string[] = [];
    h.lifecycle.onChange(() => seen.push('changed'));
    const establishing = h.lifecycle.establish();
    const rejected = expect(establishing).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    await h.lifecycle.invalidate();

    await rejected;
    expect(h.storage.value).toBeUndefined();
    expect(seen.length).toBeGreaterThan(0);
  });

  it('removes a stale active record if invalidation wins while durable put is in flight', async () => {
    const h = host({ running: true });
    h.storage.deferredPut = deferred<void>();

    const establishing = h.lifecycle.establish();
    while (!h.calls.includes('put')) await Promise.resolve();
    const invalidating = h.lifecycle.invalidate();
    h.storage.deferredPut.resolve();

    await expect(establishing).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    await invalidating;
    expect(h.storage.value).toBeUndefined();
  });

  it('preserves replacement R2 when invalidate(R1) linearizes after pending R2 publish', async () => {
    const r1 = runtime('runtime-1', 'inc-old');
    const h = host({
      stored: record(r1),
      running: true,
      incarnation: 'inc-new'
    });
    h.storage.deferredPut = deferred<void>();

    const establishing = h.lifecycle.establish();
    while (!h.calls.includes('put')) await Promise.resolve();
    const invalidating = h.lifecycle.invalidate(r1);
    h.storage.deferredPut.resolve();

    const established = await establishing;
    await invalidating;
    expect(h.storage.value).toEqual(record(established));
  });

  it('linearizes stale-read invalidate(R1) against poised R2 publish under the mutation gate', async () => {
    const r1 = runtime('runtime-1', 'inc-old');
    const compat = deferred<void>();
    const h = host({
      stored: record(r1),
      running: true,
      incarnation: 'inc-new',
      deferredCompat: compat
    });

    const establishing = h.lifecycle.establish();
    while (!h.calls.includes('compat')) await Promise.resolve();
    h.storage.deferredGetAfterRead = deferred<void>();
    const invalidating = h.lifecycle.invalidate(r1);
    await Promise.resolve();
    compat.resolve();
    await Promise.resolve();

    expect(h.calls).not.toContain('put');
    h.storage.deferredGetAfterRead.resolve();

    await invalidating;
    await expect(establishing).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    expect(h.calls).not.toContain('put');
    expect(h.storage.value).toBeUndefined();
  });

  it('keeps R2 when stale invalidate(R1) runs after R2 put is visible', async () => {
    const r1 = runtime('runtime-1', 'inc-old');
    const h = host({
      stored: record(r1),
      running: true,
      incarnation: 'inc-new'
    });
    h.storage.deferredPutAfterVisible = deferred<void>();

    const establishing = h.lifecycle.establish();
    while (!h.calls.includes('put')) await Promise.resolve();
    while (h.storage.value === undefined || h.storage.value.id === r1.id)
      await Promise.resolve();
    const r2Record = h.storage.value as RuntimeRecord;
    const invalidating = h.lifecycle.invalidate(r1);
    h.storage.deferredPutAfterVisible.resolve();

    await expect(establishing).resolves.toMatchObject({ id: r2Record.id });
    await invalidating;
    expect(h.storage.value).toEqual(r2Record);
  });

  it('removes R2 when qualified invalidate(R2) runs after R2 publish linearizes', async () => {
    const r1 = runtime('runtime-1', 'inc-old');
    const h = host({
      stored: record(r1),
      running: true,
      incarnation: 'inc-new'
    });
    h.storage.deferredPutAfterVisible = deferred<void>();

    const establishing = h.lifecycle.establish();
    while (!h.calls.includes('put')) await Promise.resolve();
    while (h.storage.value === undefined || h.storage.value.id === r1.id)
      await Promise.resolve();
    const r2Record = h.storage.value as RuntimeRecord;
    const invalidating = h.lifecycle.invalidate(new RuntimeIdentity(r2Record));
    h.storage.deferredPutAfterVisible.resolve();

    await expect(establishing).resolves.toMatchObject({ id: r2Record.id });
    await invalidating;
    expect(h.storage.value).toBeUndefined();
  });

  it('isolates listener exceptions during publish and invalidate cleanup', async () => {
    const h = host({ running: true });
    h.lifecycle.onChange(() => {
      throw new Error('listener failed');
    });

    await expect(h.lifecycle.establish()).resolves.toBeInstanceOf(
      RuntimeIdentity
    );
    await expect(h.lifecycle.invalidate()).resolves.toBeUndefined();

    expect(h.calls).toContain('stop');
    expect(h.storage.value).toBeUndefined();
  });

  it('physically stops and notifies listeners synchronously before awaited cleanup', async () => {
    const existing = runtime('runtime-1', 'inc-1');
    const h = host({ stored: record(existing), running: true });
    const seen: string[] = [];
    h.lifecycle.onChange(() => seen.push(h.calls.join(',')));

    await h.lifecycle.invalidate(existing);

    expect(seen[0]).toBe('');
    expect(h.calls).toEqual(['closeActive', 'stop']);
    expect(h.storage.value).toBeUndefined();
  });

  it('deletes only matching authority on invalidate(expected)', async () => {
    const first = runtime('runtime-1', 'inc-1');
    const second = runtime('runtime-2', 'inc-2');
    const h = host({ stored: record(second), running: true });

    await h.lifecycle.invalidate(first);

    expect(h.storage.value).toEqual(record(second));
    expect(h.calls).toEqual([]);
  });

  it('invalidates sessions without permanently disposing later establishment', async () => {
    const h = host({ running: true });

    const first = await h.lifecycle.establish();
    await h.lifecycle.invalidate(first);
    const second = await h.lifecycle.establish();

    expect(second.id).not.toBe(first.id);
    expect(h.sessions.acquire).toHaveBeenCalledTimes(2);
    expect(h.sessions.closeActive).toHaveBeenCalledTimes(1);
    expect(h.sessions.dispose).not.toHaveBeenCalled();
  });

  it('supports repeated establish and qualified invalidate cycles without retained invalidation state', async () => {
    const h = host({ running: true });

    for (let index = 0; index < 5; index++) {
      h.setRunning(true);
      const active = await h.lifecycle.establish();
      await h.lifecycle.invalidate(active);
      expect(h.storage.value).toBeUndefined();
    }

    h.setRunning(true);
    const final = await h.lifecycle.establish();

    expect(h.storage.value).toEqual(record(final));
    expect(h.sessions.acquire).toHaveBeenCalledTimes(6);
    expect(h.sessions.closeActive).toHaveBeenCalledTimes(5);
  });

  it('invokes only replacement reconciliation and leaves feature-owned adoption records untouched', async () => {
    const h = host({ running: true });
    const featureOwnedRecords = {
      restoreAttempt: { status: 'running' },
      mountLocalSync: { path: '/workspace' },
      namedTunnel: { needsRespawn: false },
      preview: { active: true }
    };

    await h.lifecycle.establish();

    expect(h.calls).toContain('reconcile');
    expect(Object.keys(h.lifecycleOptions)).not.toEqual(
      expect.arrayContaining([
        'restore',
        'mountLocalSync',
        'namedTunnelProvision',
        'previewActivation'
      ])
    );
    expect(featureOwnedRecords).toEqual({
      restoreAttempt: { status: 'running' },
      mountLocalSync: { path: '/workspace' },
      namedTunnel: { needsRespawn: false },
      preview: { active: true }
    });
  });
});
