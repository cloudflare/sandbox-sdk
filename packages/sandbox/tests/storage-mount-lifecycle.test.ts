import { describe, expect, it, vi } from 'vitest';
import { RuntimeIdentity, type RuntimeIdentityReader } from '../src/runtime';
import type { CurrentSandboxLifetime } from '../src/sandbox-lifetime';
import { MountLifecycle } from '../src/storage-mount/lifecycle';

function runtime(id: string, incarnation: string): RuntimeIdentity {
  return new RuntimeIdentity({
    id: id as RuntimeIdentity['id'],
    runtimeIncarnationID: incarnation as RuntimeIdentity['runtimeIncarnationID']
  });
}

describe('MountLifecycle', () => {
  it('fences registry commits to the exact admitted incarnation', async () => {
    const admitted = runtime('runtime-1', 'incarnation-1');
    const order: string[] = [];
    const runtimeReader = {
      get: vi.fn(),
      getStored: vi.fn(),
      isActive: vi.fn(),
      assertActive: vi.fn(async (candidate: RuntimeIdentity) => {
        order.push('runtime');
        expect(candidate).toBe(admitted);
      })
    } satisfies RuntimeIdentityReader;
    const lifetime = { id: 'lifetime-1', generation: 1 };
    const currentLifetime = {
      getOrCreate: vi.fn(async () => lifetime),
      assertCurrent: vi.fn(async () => {
        order.push('lifetime');
      })
    } as unknown as CurrentSandboxLifetime;
    const lifecycle = new MountLifecycle(runtimeReader, currentLifetime);

    const snapshot = await lifecycle.capture(admitted);
    await lifecycle.assertCurrent(snapshot);

    expect(snapshot.runtime).toBe(admitted);
    expect(runtimeReader.get).not.toHaveBeenCalled();
    expect(order).toEqual(['lifetime', 'runtime']);
  });
});
