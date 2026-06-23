import { describe, expect, it, vi } from 'vitest';
import {
  CurrentSandboxLifetime,
  SandboxLifetime,
  SandboxLifetimeChangedError
} from '../src/sandbox-lifetime';

function createStorage(initial = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key) ?? null),
    put: vi.fn(async (key: string, value: unknown) => {
      initial.set(key, value);
    })
  };
}

describe('CurrentSandboxLifetime', () => {
  it('getOrCreate() returns a stable id on repeated calls', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const first = await currentLifetime.getOrCreate();
    const second = await currentLifetime.getOrCreate();

    expect(first.id).toBe(second.id);
    expect(typeof first.id).toBe('string');
    expect(first.id.length).toBeGreaterThan(0);
  });

  it('getOrCreate() persists the record to storage', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    await currentLifetime.getOrCreate();

    // Storage must have been written
    expect(storage.put).toHaveBeenCalledOnce();
    expect(map.has('sandbox:lifetime')).toBe(true);
  });

  it('getOrCreate() does not overwrite an existing lifetime', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const first = await currentLifetime.getOrCreate();
    // put should have been called exactly once — the second call reads from storage
    const putCallsBefore = storage.put.mock.calls.length;
    const second = await currentLifetime.getOrCreate();

    expect(storage.put.mock.calls.length).toBe(putCallsBefore);
    expect(second.id).toBe(first.id);
  });

  it('rotate() changes the lifetime id', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const original = await currentLifetime.getOrCreate();
    const rotated = await currentLifetime.rotate();

    expect(rotated.id).not.toBe(original.id);
  });

  it('rotate() increments the generation', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const original = await currentLifetime.getOrCreate();
    const rotated = await currentLifetime.rotate();

    expect(rotated.generation).toBeGreaterThan(original.generation);
  });

  it('assertCurrent() resolves when lifetime matches current storage', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const lifetime = await currentLifetime.getOrCreate();
    await expect(
      currentLifetime.assertCurrent(lifetime)
    ).resolves.toBeUndefined();
  });

  it('assertCurrent() throws SandboxLifetimeChangedError for a stale lifetime', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const stale = await currentLifetime.getOrCreate();
    // Rotate so the stored id is different from stale
    await currentLifetime.rotate();

    await expect(currentLifetime.assertCurrent(stale)).rejects.toThrow(
      SandboxLifetimeChangedError
    );
  });

  it('isCurrent() returns true for current lifetime', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const lifetime = await currentLifetime.getOrCreate();
    expect(await currentLifetime.isCurrent(lifetime)).toBe(true);
  });

  it('isCurrent() returns false for stale lifetime after rotate', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const stale = await currentLifetime.getOrCreate();
    await currentLifetime.rotate();

    expect(await currentLifetime.isCurrent(stale)).toBe(false);
  });

  it('SandboxLifetimeChangedError has the expected name and message', () => {
    const err = new SandboxLifetimeChangedError();
    expect(err.name).toBe('SandboxLifetimeChangedError');
    expect(err.message).toBe('Sandbox lifetime is no longer current');
  });

  it('SandboxLifetime.owns() returns true for a scoped record', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const lifetime = await currentLifetime.getOrCreate();
    const scoped = lifetime.scope({ data: 'test' });
    expect(lifetime.owns(scoped)).toBe(true);
  });

  it('SandboxLifetime.owns() returns false for a record from a different lifetime', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(
      storage as unknown as DurableObjectState['storage']
    );

    const first = await currentLifetime.getOrCreate();
    const second = await currentLifetime.rotate();
    const scoped = second.scope({ data: 'test' });

    expect(first.owns(scoped)).toBe(false);
  });
});
