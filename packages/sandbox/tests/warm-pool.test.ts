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
        get: vi.fn(() => ({ start, startAndWaitForPorts }))
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
});
