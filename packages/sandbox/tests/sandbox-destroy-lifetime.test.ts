import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';

vi.mock('@cloudflare/containers', () => {
  class MockContainer {
    ctx: DurableObjectState;
    env: unknown;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    async destroy(): Promise<void> {}

    async getState(): Promise<{ status: string }> {
      return { status: 'healthy' };
    }
  }

  return {
    Container: MockContainer,
    ContainerProxy: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

type StorageCall =
  | { method: 'get'; key: string }
  | { method: 'put'; key: string; value: unknown }
  | { method: 'delete'; key: string };

function createMockState() {
  const values = new Map<string, unknown>();
  const calls: StorageCall[] = [];

  const storage = {
    get: vi.fn(async (key: string) => {
      calls.push({ method: 'get', key });
      return values.get(key);
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      calls.push({ method: 'put', key, value });
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      calls.push({ method: 'delete', key });
      values.delete(key);
    }),
    list: vi.fn(async () => new Map<string, unknown>()),
    transaction: vi.fn(
      async (callback: (txn: DurableObjectStorage) => Promise<unknown>) =>
        callback(storage)
    )
  } as unknown as DurableObjectStorage;

  const state = {
    storage,
    blockConcurrencyWhile: vi.fn(<T>(callback: () => Promise<T>) => callback()),
    waitUntil: vi.fn(),
    id: {
      toString: () => 'test-sandbox-id',
      equals: vi.fn(),
      name: 'test-sandbox'
    }
  } as unknown as DurableObjectState<{}>;

  return { state, calls, values };
}

describe('Sandbox destroy lifetime fencing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T11:00:00.000Z'));
  });

  it('rotates sandbox lifetime before clearing runtime identity during destroy', async () => {
    const { state, calls, values } = createMockState();
    values.set('currentRuntimeIdentity', { id: 'runtime-before-destroy' });

    const sandbox = new Sandbox(state, {});
    await vi.waitFor(() => {
      expect(state.blockConcurrencyWhile).toHaveBeenCalled();
    });

    await sandbox.destroy();

    const lifetimePutIndex = calls.findIndex(
      (call) => call.method === 'put' && call.key === 'sandbox:lifetime'
    );
    const runtimeClearIndex = calls.findIndex(
      (call) =>
        call.method === 'delete' && call.key === 'currentRuntimeIdentity'
    );

    expect(lifetimePutIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeClearIndex).toBeGreaterThanOrEqual(0);
    expect(lifetimePutIndex).toBeLessThan(runtimeClearIndex);

    expect(values.get('sandbox:lifetime')).toMatchObject({
      id: expect.any(String),
      generation: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    });
  });
});
