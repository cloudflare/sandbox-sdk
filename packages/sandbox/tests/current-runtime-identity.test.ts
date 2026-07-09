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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it('invalidates a status read awaiting container state when markStarted begins', async () => {
    const map = new Map<string, unknown>([
      ['currentRuntimeIdentity', { id: 'runtime-1' }]
    ]);
    const state = deferred<{ status: string }>();
    const putMutation = deferred<void>();
    const get = vi.fn(async (key: string) => map.get(key));
    const put = vi.fn(async (key: string, value: unknown) => {
      await putMutation.promise;
      map.set(key, value);
    });
    const storage = {
      get,
      put,
      delete: vi.fn()
    } as unknown as DurableObjectState['storage'];
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => state.promise,
      () => true
    );

    const captured = currentRuntime.getStatus();
    const starting = currentRuntime.markStarted();
    state.resolve({ status: 'healthy' });

    await expect(captured).resolves.toEqual({
      status: 'inactive',
      reason: 'missing-runtime-id'
    });
    expect(get).not.toHaveBeenCalled();

    putMutation.resolve();
    await starting;
  });

  it('invalidates a status read awaiting storage when clear begins', async () => {
    const stored = deferred<unknown>();
    const deletion = deferred<boolean>();
    const get = vi.fn(async () => stored.promise);
    const deleteIdentity = vi.fn(async () => deletion.promise);
    const storage = {
      get,
      put: vi.fn(),
      delete: deleteIdentity
    } as unknown as DurableObjectState['storage'];
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );

    const captured = currentRuntime.getStatus();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const clearing = currentRuntime.clear();
    stored.resolve({ id: 'runtime-1' });

    await expect(captured).resolves.toEqual({
      status: 'inactive',
      reason: 'missing-runtime-id'
    });

    deletion.resolve(true);
    await clearing;
  });

  it('serializes overlapping transitions without dropping the transition fence', async () => {
    const map = new Map<string, unknown>([
      ['currentRuntimeIdentity', { id: 'runtime-1' }]
    ]);
    const putMutation = deferred<void>();
    const deletion = deferred<boolean>();
    const get = vi.fn(async (key: string) => map.get(key));
    const put = vi.fn(async (key: string, value: unknown) => {
      await putMutation.promise;
      map.set(key, value);
    });
    const deleteIdentity = vi.fn(async (key: string) => {
      await deletion.promise;
      map.delete(key);
      return true;
    });
    const storage = {
      get,
      put,
      delete: deleteIdentity
    } as unknown as DurableObjectState['storage'];
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );

    const starting = currentRuntime.markStarted();
    const clearing = currentRuntime.clear();

    expect(put).toHaveBeenCalledTimes(1);
    expect(deleteIdentity).not.toHaveBeenCalled();
    putMutation.resolve();
    await starting;
    await vi.waitFor(() => expect(deleteIdentity).toHaveBeenCalledTimes(1));

    await expect(currentRuntime.getStatus()).resolves.toEqual({
      status: 'inactive',
      reason: 'missing-runtime-id'
    });
    expect(get).not.toHaveBeenCalled();

    deletion.resolve(true);
    await clearing;
    expect(map.has('currentRuntimeIdentity')).toBe(false);
  });

  it('fences the old identity before a clear reaches storage', async () => {
    let releaseDelete!: (deleted: number) => void;
    const deletePending = new Promise<number>((resolve) => {
      releaseDelete = resolve;
    });
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    vi.mocked(storage.delete).mockImplementation(async () => deletePending);
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );
    const runtime = await currentRuntime.get();
    if (!runtime) throw new Error('expected active runtime');

    const clearing = currentRuntime.clear();
    await expect(currentRuntime.isActive(runtime)).resolves.toBe(false);

    releaseDelete(1);
    await clearing;
  });

  it('resets the transition fence when storage.put rejects', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const put = deferred<void>();
    vi.mocked(storage.put).mockImplementation(async () => put.promise);
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );
    const listenerStatuses: Promise<unknown>[] = [];
    const listenerStorageCalls: number[] = [];
    currentRuntime.onChange(() => {
      listenerStorageCalls.push(vi.mocked(storage.put).mock.calls.length);
      listenerStatuses.push(currentRuntime.getStatus());
    });

    const starting = currentRuntime.markStarted();

    expect(listenerStorageCalls).toEqual([0]);
    expect(storage.put).toHaveBeenCalledTimes(1);
    await expect(listenerStatuses[0]).resolves.toEqual({
      status: 'inactive',
      reason: 'missing-runtime-id'
    });

    const error = new Error('put failed');
    put.reject(error);
    await expect(starting).rejects.toBe(error);

    await expect(currentRuntime.getStatus()).resolves.toMatchObject({
      status: 'active',
      runtime: { id: 'runtime-1' },
      containerStatus: 'healthy'
    });
  });

  it('resets the transition fence when storage.delete rejects', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const deletion = deferred<number>();
    vi.mocked(storage.delete).mockImplementation(async () => deletion.promise);
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );
    const listenerStatuses: Promise<unknown>[] = [];
    const listenerStorageCalls: number[] = [];
    currentRuntime.onChange(() => {
      listenerStorageCalls.push(vi.mocked(storage.delete).mock.calls.length);
      listenerStatuses.push(currentRuntime.getStatus());
    });

    const clearing = currentRuntime.clear();

    expect(listenerStorageCalls).toEqual([0]);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    await expect(listenerStatuses[0]).resolves.toEqual({
      status: 'inactive',
      reason: 'missing-runtime-id'
    });

    const error = new Error('delete failed');
    deletion.reject(error);
    await expect(clearing).rejects.toBe(error);

    await expect(currentRuntime.get()).resolves.toMatchObject({
      id: 'runtime-1'
    });
  });

  it('resets the mark-started transition fence when a listener throws', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );
    const error = new Error('listener failed');
    currentRuntime.onChange(() => {
      expect(storage.put).not.toHaveBeenCalled();
      throw error;
    });

    await expect(currentRuntime.markStarted()).rejects.toBe(error);

    expect(storage.put).not.toHaveBeenCalled();
    await expect(currentRuntime.get()).resolves.toMatchObject({
      id: 'runtime-1'
    });
  });

  it('resets the clear transition fence when a listener throws', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );
    const error = new Error('listener failed');
    currentRuntime.onChange(() => {
      expect(storage.delete).not.toHaveBeenCalled();
      throw error;
    });

    await expect(currentRuntime.clear()).rejects.toBe(error);

    expect(storage.delete).not.toHaveBeenCalled();
    await expect(currentRuntime.get()).resolves.toMatchObject({
      id: 'runtime-1'
    });
  });

  it('notifies lifecycle owners when runtime identity changes', async () => {
    const currentRuntime = new CurrentRuntimeIdentity(
      createStorage(),
      async () => ({ status: 'healthy' }),
      () => true
    );
    const changed = vi.fn();
    const unsubscribe = currentRuntime.onChange(changed);

    await currentRuntime.markStarted();
    await currentRuntime.clear();
    unsubscribe();
    await currentRuntime.markStarted();

    expect(changed).toHaveBeenCalledTimes(2);
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
