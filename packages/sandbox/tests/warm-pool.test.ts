import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  }
}));

import { WarmPool } from '../src/bridge/warm-pool';

describe('WarmPool', () => {
  let storageData: Map<string, unknown>;
  let startAndWaitForPorts: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let destroy: ReturnType<typeof vi.fn>;
  let getState: ReturnType<typeof vi.fn>;
  let renewActivityTimeout: ReturnType<typeof vi.fn>;
  let ctx: DurableObjectState;
  let env: {
    Sandbox: {
      idFromName: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    storageData = new Map();
    startAndWaitForPorts = vi.fn(async () => undefined);
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    destroy = vi.fn(async () => undefined);
    getState = vi.fn(async () => ({ status: 'healthy' }));
    renewActivityTimeout = vi.fn();
    ctx = {
      storage: {
        get: vi.fn(async (key: string) => storageData.get(key)),
        put: vi.fn(async (key: string, value: unknown) => {
          storageData.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          storageData.delete(key);
        }),
        getAlarm: vi.fn(async () => Date.now() + 10_000),
        setAlarm: vi.fn(async () => undefined)
      }
    } as unknown as DurableObjectState;
    env = {
      Sandbox: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({
          start,
          startAndWaitForPorts,
          stop,
          destroy,
          getState,
          renewActivityTimeout
        }))
      }
    };
  });

  it('starts warm-pool containers through public lifecycle authority', async () => {
    const pool = new WarmPool(
      ctx,
      env as unknown as ConstructorParameters<typeof WarmPool>[1]
    );

    const containerId = await pool.getContainer('sandbox-a');

    expect(containerId).toEqual(expect.any(String));
    expect(startAndWaitForPorts).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('destroys discarded prewarmed containers before releasing tracking', async () => {
    storageData.set('warmContainers', new Set(['warm-a']));
    const pool = new WarmPool(
      ctx,
      env as unknown as ConstructorParameters<typeof WarmPool>[1]
    );

    await pool.shutdownPrewarmed();

    expect(destroy).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    await expect(pool.getStats()).resolves.toMatchObject({ warm: 0 });
  });

  it('destroys excess prewarmed containers during scale-down', async () => {
    storageData.set('warmContainers', new Set(['warm-a', 'warm-b']));
    storageData.set('config', { warmTarget: 1, refreshInterval: 10_000 });
    const pool = new WarmPool(
      ctx,
      env as unknown as ConstructorParameters<typeof WarmPool>[1]
    );

    await pool.alarm();

    expect(destroy).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    await expect(pool.getStats()).resolves.toMatchObject({ warm: 1 });
  });
});
