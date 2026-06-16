import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CurrentSandboxLifetime,
  SandboxLifetimeChangedError
} from '../src/sandbox-lifetime';

function createStorage(initial = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      initial.set(key, value);
    })
  } as unknown as DurableObjectState['storage'];
}

describe('CurrentSandboxLifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an lifetime lazily and returns the stored record on later reads', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(storage);

    const created = await currentLifetime.getOrCreate();
    const reread = await currentLifetime.getOrCreate();

    expect(created.id).toEqual(expect.any(String));
    expect(created.generation).toBe(1);
    expect(created.createdAt).toBe('2026-06-15T10:00:00.000Z');
    expect(created.updatedAt).toBe('2026-06-15T10:00:00.000Z');
    expect(reread).toEqual(created);
    expect(map.get('sandbox:lifetime')).toEqual(created.record);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('rotates to a new lifetime and increments the generation', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentLifetime = new CurrentSandboxLifetime(storage);

    const first = await currentLifetime.getOrCreate();
    vi.setSystemTime(new Date('2026-06-15T10:05:00.000Z'));

    const rotated = await currentLifetime.rotate();

    expect(rotated.id).not.toBe(first.id);
    expect(rotated.generation).toBe(2);
    expect(rotated.createdAt).toBe('2026-06-15T10:05:00.000Z');
    expect(rotated.updatedAt).toBe('2026-06-15T10:05:00.000Z');
    expect(map.get('sandbox:lifetime')).toEqual(rotated.record);
  });

  it('throws a typed error when asserting a stale lifetime', async () => {
    const storage = createStorage();
    const currentLifetime = new CurrentSandboxLifetime(storage);

    const first = await currentLifetime.getOrCreate();
    await currentLifetime.rotate();

    await expect(currentLifetime.assertCurrent(first)).rejects.toBeInstanceOf(
      SandboxLifetimeChangedError
    );
  });
});
