import { Container } from '@cloudflare/containers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, Sandbox } from '../src/sandbox';

vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: unknown;
    env: unknown;
    sleepAfter: string | number = '10m';
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(_request: Request): Promise<Response> {
      return new Response('Mock');
    }
    async containerFetch(_request: Request, _port: number): Promise<Response> {
      return new Response('Mock');
    }
    async startAndWaitForPorts(): Promise<void> {}
    async destroy(): Promise<void> {}
    async stop(): Promise<void> {}
    async getState() {
      return { status: 'healthy' };
    }
    renewActivityTimeout() {}
  };

  const MockContainerProxy = class ContainerProxy {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(_request: Request): Promise<Response> {
      return new Response('Mock');
    }
  };

  return {
    Container: MockContainer,
    ContainerProxy: MockContainerProxy,
    getContainer: vi.fn(),
    switchPort: vi.fn((request: Request) => request)
  };
});

describe('Sandbox destroy() sandbox lifetime', () => {
  let sandbox: Sandbox;
  let putCalls: Array<{ key: string; seq: number }>;
  let deleteCalls: Array<{ key: string; seq: number }>;
  let callSeq: number;

  beforeEach(async () => {
    vi.clearAllMocks();

    putCalls = [];
    deleteCalls = [];
    callSeq = 0;

    const storageState = new Map<string, unknown>();

    const storage = {
      get: vi.fn(async (key: string) => storageState.get(key) ?? null),
      put: vi.fn(async (key: string, value: unknown) => {
        putCalls.push({ key, seq: callSeq++ });
        storageState.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        deleteCalls.push({ key, seq: callSeq++ });
        storageState.delete(key);
      }),
      list: vi.fn().mockResolvedValue(new Map()),
      transaction: vi.fn(async (callback: (s: typeof storage) => unknown) =>
        callback(storage)
      )
    };

    const mockCtx = {
      storage,
      blockConcurrencyWhile: vi
        .fn()
        .mockImplementation(<T>(cb: () => Promise<T>): Promise<T> => cb()),
      waitUntil: vi.fn(),
      container: { running: true, start: vi.fn() },
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox'
      }
    };

    const stub = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );

    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });
    await Promise.all(
      (
        mockCtx.blockConcurrencyWhile as {
          mock: { results: Array<{ value: unknown }> };
        }
      ).mock.results.map((r) => r.value)
    );

    sandbox = Object.assign(stub, { wsConnect: connect(stub) });

    vi.spyOn(Container.prototype, 'destroy').mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates sandbox lifetime before clearing currentRuntimeIdentity', async () => {
    await sandbox.destroy();

    // The sandbox:lifetime rotation put must exist
    const lifetimePut = putCalls.find((c) => c.key === 'sandbox:lifetime');
    expect(lifetimePut, 'expected a put to sandbox:lifetime').toBeDefined();

    // The currentRuntimeIdentity delete must exist
    const runtimeDelete = deleteCalls.find(
      (c) => c.key === 'currentRuntimeIdentity'
    );
    expect(
      runtimeDelete,
      'expected a delete of currentRuntimeIdentity'
    ).toBeDefined();

    if (!lifetimePut || !runtimeDelete) {
      throw new Error('Expected lifetime rotation and runtime clear calls');
    }
    expect(lifetimePut.seq).toBeLessThan(runtimeDelete.seq);
  });

  it('does not rotate lifetime during onStart()', async () => {
    putCalls = [];

    // Simulate onStart (called internally by the container lifecycle)
    await (sandbox as unknown as { onStart: () => Promise<void> }).onStart();

    const lifetimePut = putCalls.find((c) => c.key === 'sandbox:lifetime');
    expect(lifetimePut).toBeUndefined();
  });

  it('does not rotate lifetime during onStop()', async () => {
    putCalls = [];

    // Simulate onStop
    await (sandbox as unknown as { onStop: () => Promise<void> }).onStop();

    const lifetimePut = putCalls.find((c) => c.key === 'sandbox:lifetime');
    expect(lifetimePut).toBeUndefined();
  });

  it('resolves (idempotent no-op) when the container was never admitted', async () => {
    // Destroying a sandbox whose container never started (e.g. no instance
    // available under capacity pressure) must not throw: there is nothing to
    // tear down. The base container.destroy() throws the platform no-instance
    // error; Sandbox.destroy() should treat it as success.
    vi.spyOn(Container.prototype, 'destroy').mockRejectedValue(
      new Error(
        'There is no container instance that can be provided to this Durable Object, try again later'
      )
    );

    await expect(sandbox.destroy()).resolves.toBeUndefined();
  });

  it('still rejects when the container destroy fails for a non-no-instance reason', async () => {
    vi.spyOn(Container.prototype, 'destroy').mockRejectedValue(
      new Error('some other teardown failure')
    );

    await expect(sandbox.destroy()).rejects.toThrow(
      'some other teardown failure'
    );
  });
});
