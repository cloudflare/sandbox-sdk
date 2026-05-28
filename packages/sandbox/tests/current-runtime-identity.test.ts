import { describe, expect, it, vi } from 'vitest';
import {
  CurrentRuntimeIdentity,
  RuntimeIdentityInactiveError
} from '../src/current-runtime-identity';

function createStorage(initial = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      initial.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      initial.delete(key);
    })
  } as unknown as DurableObjectState['storage'];
}

describe('CurrentRuntimeIdentity', () => {
  it('returns inactive when the container is not healthy', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'stopped' }),
      () => true
    );

    await expect(currentRuntime.getStatus()).resolves.toMatchObject({
      status: 'inactive',
      reason: 'runtime-not-healthy',
      containerStatus: 'stopped'
    });
  });

  it('returns inactive when the container is not running', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => false
    );

    await expect(currentRuntime.getStatus()).resolves.toMatchObject({
      status: 'inactive',
      reason: 'runtime-not-running',
      containerStatus: 'healthy'
    });
  });

  it('returns inactive when the runtime identity is missing', async () => {
    const currentRuntime = new CurrentRuntimeIdentity(
      createStorage(),
      async () => ({ status: 'healthy' }),
      () => true
    );

    await expect(currentRuntime.getStatus()).resolves.toMatchObject({
      status: 'inactive',
      reason: 'missing-runtime-id',
      containerStatus: 'healthy'
    });
  });

  it('returns active when storage, health, and running state agree', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );

    const status = await currentRuntime.getStatus();

    expect(status.status).toBe('active');
    if (status.status === 'active') {
      expect(status.runtime.id).toBe('runtime-1');
      expect(status.containerStatus).toBe('healthy');
    }
  });

  it('marks and clears the current runtime identity', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );

    const runtime = await currentRuntime.markStarted();

    expect(map.get('currentRuntimeIdentity')).toEqual({ id: runtime.id });

    await currentRuntime.clear();

    expect(map.has('currentRuntimeIdentity')).toBe(false);
  });

  it('throws a typed error when asserting an inactive runtime', async () => {
    const currentRuntime = new CurrentRuntimeIdentity(
      createStorage(),
      async () => ({ status: 'healthy' }),
      () => true
    );
    const runtime = await currentRuntime.markStarted();

    await currentRuntime.clear();

    await expect(currentRuntime.assertActive(runtime)).rejects.toBeInstanceOf(
      RuntimeIdentityInactiveError
    );
  });
});
