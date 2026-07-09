import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectionGenerations: number[] = [];
const rpcGenerations: number[] = [];
const processStarts: number[] = [];
const terminalCreates: number[] = [];
const startAndWaitForPortsCalls: unknown[] = [];
let connected = true;
let nextConnectionGeneration = 0;

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: { container?: { start?: () => Promise<void>; running?: boolean } };
    env: unknown;
    private startPromise: Promise<void> | null = null;

    constructor(
      ctx: { container?: { start?: () => Promise<void> } },
      env: unknown
    ) {
      this.ctx = ctx;
      this.env = env;
    }

    async start(): Promise<void> {
      if (!this.startPromise) {
        this.startPromise = (
          this.ctx.container?.start?.() ?? Promise.resolve()
        ).finally(() => {
          this.startPromise = null;
        });
      }
      await this.startPromise;
    }

    async onActivityExpired(): Promise<void> {}

    async getState(): Promise<{ status: string }> {
      return { status: 'healthy' };
    }

    async startAndWaitForPorts(options: unknown): Promise<void> {
      startAndWaitForPortsCalls.push(options);
      await this.start();
    }

    renewActivityTimeout(): void {}
  };

  return {
    Container: MockContainer,
    ContainerProxy: class ContainerProxy {},
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

vi.mock('../src/container-control/connection', () => ({
  ContainerControlConnection: class {
    private readonly generation: number;

    constructor() {
      this.generation = nextConnectionGeneration;
      nextConnectionGeneration += 1;
      connectionGenerations.push(this.generation);
    }

    isConnected() {
      return connected;
    }

    getStats() {
      return { imports: 1, exports: 1 };
    }

    disconnect() {
      connected = false;
    }

    rpc() {
      rpcGenerations.push(this.generation);
      return {
        processes: {
          start: async (command: [string, ...string[]]) => {
            processStarts.push(this.generation);
            return {
              id: `process-${this.generation}`,
              pid: 1000 + this.generation,
              command,
              state: 'running',
              startedAt: new Date().toISOString()
            };
          },
          hasActive: async () => false
        },
        terminals: {
          create: async () => {
            terminalCreates.push(this.generation);
            return { id: `terminal-${this.generation}` };
          },
          hasActive: async () => false
        },
        ports: {}
      };
    }

    async connect() {}
  }
}));

import { connect, Sandbox } from '../src/sandbox';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createSandbox() {
  const storageState = new Map<string, unknown>();
  let stub!: Sandbox;
  const startContainer = async () => {
    ctx.container.running = true;
    await stub.onStart();
  };
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => storageState.get(key) ?? null),
      put: vi.fn(async (key: string, value: unknown) => {
        storageState.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        storageState.delete(key);
      }),
      list: vi.fn(async () => new Map()),
      transaction: vi.fn(async (callback) => callback(ctx.storage))
    },
    blockConcurrencyWhile: vi.fn(<T>(callback: () => Promise<T>) => callback()),
    waitUntil: vi.fn(),
    container: {
      running: true,
      start: vi.fn(startContainer)
    },
    id: {
      toString: () => 'sandbox-activity-gate-test',
      equals: vi.fn(),
      name: 'sandbox-activity-gate-test'
    }
  };

  stub = new Sandbox(
    ctx as unknown as ConstructorParameters<typeof Sandbox>[0],
    {}
  );
  const sandbox = Object.assign(stub, { wsConnect: connect(stub) });

  await Promise.all(
    ctx.blockConcurrencyWhile.mock.results.map((result) => result.value)
  );

  return { sandbox, ctx };
}

describe('Sandbox resource activity gate integration', () => {
  beforeEach(() => {
    connected = true;
    nextConnectionGeneration = 0;
    connectionGenerations.length = 0;
    rpcGenerations.length = 0;
    processStarts.length = 0;
    terminalCreates.length = 0;
    startAndWaitForPortsCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads runtime liveness without starting or creating a control connection', async () => {
    const { sandbox, ctx } = await createSandbox();
    await ctx.storage.put('currentRuntimeIdentity', { id: 'runtime-a' });

    await expect(sandbox.isRuntimeActive()).resolves.toBe(true);

    expect(ctx.container.start).not.toHaveBeenCalled();
    expect(startAndWaitForPortsCalls).toHaveLength(0);
    expect(connectionGenerations).toHaveLength(0);
    expect(rpcGenerations).toHaveLength(0);
  });

  it('holds exec and terminal creation behind a pending committed inactivity stop', async () => {
    const { sandbox, ctx } = await createSandbox();
    const stop = deferred();
    vi.spyOn(
      Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
      'onActivityExpired'
    ).mockImplementation(() => {
      sandbox.client.disconnect();
      return stop.promise;
    });

    const expiry = sandbox.onActivityExpired();
    await vi.waitFor(() => expect(rpcGenerations.length).toBeGreaterThan(0));
    expect(ctx.container.start).not.toHaveBeenCalled();
    const rpcGenerationsBeforeStopSettles = [...rpcGenerations];
    const connectionGenerationsBeforeStopSettles = [...connectionGenerations];

    ctx.container.running = false;
    connected = false;
    const exec = sandbox.exec(['echo', 'ok']);
    const terminal = sandbox.createTerminal({ command: ['sh'] });
    await Promise.resolve();

    expect(ctx.container.start).not.toHaveBeenCalled();
    expect(connectionGenerations).toEqual(
      connectionGenerationsBeforeStopSettles
    );
    expect(rpcGenerations).toEqual(rpcGenerationsBeforeStopSettles);
    expect(processStarts).toHaveLength(0);
    expect(terminalCreates).toHaveLength(0);

    connected = true;
    stop.resolve();
    await expiry;
    await Promise.all([exec, terminal]);

    expect(ctx.container.start).toHaveBeenCalledTimes(1);
    expect(connectionGenerations.at(-1)).toBeGreaterThan(
      connectionGenerationsBeforeStopSettles.at(-1) ?? -1
    );
    expect(processStarts).toEqual([1]);
    expect(terminalCreates).toEqual([1]);
  });

  it('holds exposePort startup behind a pending committed inactivity stop', async () => {
    const { sandbox, ctx } = await createSandbox();
    (sandbox as any).sandboxName = 'sandbox-activity-gate-test';
    const stop = deferred();
    vi.spyOn(
      Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
      'onActivityExpired'
    ).mockImplementation(() => {
      sandbox.client.disconnect();
      return stop.promise;
    });
    const expiry = sandbox.onActivityExpired();
    await vi.waitFor(() => expect(rpcGenerations.length).toBeGreaterThan(0));
    expect(ctx.container.start).not.toHaveBeenCalled();

    ctx.container.running = false;
    const exposed = sandbox.exposePort(8080, { hostname: 'example.com' });
    await Promise.resolve();

    expect(startAndWaitForPortsCalls).toHaveLength(0);
    expect(ctx.container.start).not.toHaveBeenCalled();

    stop.resolve();
    await expiry;
    await expect(exposed).resolves.toMatchObject({ port: 8080 });

    expect(startAndWaitForPortsCalls).toHaveLength(1);
    expect(ctx.container.start).toHaveBeenCalledTimes(1);
  });

  it('releases the gate operation count when post-stop startup fails so a retry can run', async () => {
    const { sandbox, ctx } = await createSandbox();
    const stop = deferred();
    vi.spyOn(
      Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
      'onActivityExpired'
    ).mockImplementation(() => {
      sandbox.client.disconnect();
      return stop.promise;
    });

    const expiry = sandbox.onActivityExpired();
    await Promise.resolve();
    ctx.container.running = false;
    connected = false;

    const startFailure = new Error('start failed');
    ctx.container.start.mockRejectedValueOnce(startFailure);
    const first = sandbox.exec(['echo', 'first']);
    await Promise.resolve();
    expect(ctx.container.start).not.toHaveBeenCalled();

    connected = true;
    stop.resolve();
    await expiry;
    await expect(first).rejects.toThrow('start failed');
    expect(processStarts).toHaveLength(0);

    await sandbox.exec(['echo', 'retry']);

    expect(ctx.container.start).toHaveBeenCalledTimes(2);
    expect(processStarts).toHaveLength(1);
  });
});
