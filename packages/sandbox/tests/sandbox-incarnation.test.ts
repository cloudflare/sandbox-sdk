import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CurrentSandboxIncarnation,
  SandboxIncarnationChangedError
} from '../src/sandbox-incarnation';

function createStorage(initial = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      initial.set(key, value);
    })
  } as unknown as DurableObjectState['storage'];
}

describe('CurrentSandboxIncarnation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an incarnation lazily and returns the stored record on later reads', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentIncarnation = new CurrentSandboxIncarnation(storage);

    const created = await currentIncarnation.getOrCreate();
    const reread = await currentIncarnation.getOrCreate();

    expect(created.id).toEqual(expect.any(String));
    expect(created.generation).toBe(1);
    expect(created.createdAt).toBe('2026-06-15T10:00:00.000Z');
    expect(created.updatedAt).toBe('2026-06-15T10:00:00.000Z');
    expect(reread).toEqual(created);
    expect(map.get('sandbox:incarnation')).toEqual(created.record);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('rotates to a new incarnation and increments the generation', async () => {
    const map = new Map<string, unknown>();
    const storage = createStorage(map);
    const currentIncarnation = new CurrentSandboxIncarnation(storage);

    const first = await currentIncarnation.getOrCreate();
    vi.setSystemTime(new Date('2026-06-15T10:05:00.000Z'));

    const rotated = await currentIncarnation.rotate();

    expect(rotated.id).not.toBe(first.id);
    expect(rotated.generation).toBe(2);
    expect(rotated.createdAt).toBe('2026-06-15T10:05:00.000Z');
    expect(rotated.updatedAt).toBe('2026-06-15T10:05:00.000Z');
    expect(map.get('sandbox:incarnation')).toEqual(rotated.record);
  });

  it('throws a typed error when asserting a stale incarnation', async () => {
    const storage = createStorage();
    const currentIncarnation = new CurrentSandboxIncarnation(storage);

    const first = await currentIncarnation.getOrCreate();
    await currentIncarnation.rotate();

    await expect(
      currentIncarnation.assertCurrent(first)
    ).rejects.toBeInstanceOf(SandboxIncarnationChangedError);
  });
});
