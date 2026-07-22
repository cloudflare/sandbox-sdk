import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectionGenerations: number[] = [];
const rpcGenerations: number[] = [];
const processStarts: number[] = [];
const terminalCreates: number[] = [];
const terminalOutputCancels: number[] = [];
const startAndWaitForPortsCalls: unknown[] = [];
const physicalStops: number[] = [];
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

    private async physicalStart(): Promise<void> {
      if (this.ctx.container?.running === true) return;
      if (!this.startPromise) {
        this.startPromise = (
          this.ctx.container?.start?.() ?? Promise.resolve()
        ).finally(() => {
          this.startPromise = null;
        });
      }
      await this.startPromise;
    }

    async start(): Promise<void> {
      await this.physicalStart();
    }

    async stop(): Promise<void> {
      physicalStops.push(physicalStops.length);
      if (this.ctx.container) this.ctx.container.running = false;
    }

    async onActivityExpired(): Promise<void> {
      await this.stop();
    }

    async getState(): Promise<{ status: string }> {
      return { status: 'healthy' };
    }

    async startAndWaitForPorts(options: unknown): Promise<void> {
      startAndWaitForPortsCalls.push(options);
      await this.physicalStart();
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
    private connectionOpen = true;
    private activated = false;

    constructor() {
      this.generation = nextConnectionGeneration;
      nextConnectionGeneration += 1;
      connectionGenerations.push(this.generation);
    }

    isConnected() {
      return this.connectionOpen && connected;
    }

    getStats() {
      return { imports: 1, exports: 1 };
    }

    disconnect() {
      this.connectionOpen = false;
    }

    rpc() {
      if (!this.activated) throw new Error('control session not activated');
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
          output: async () => {
            const generation = this.generation;
            return {
              stream: async () =>
                new ReadableStream({
                  start(controller) {
                    controller.enqueue({
                      type: 'terminal',
                      terminalId: `terminal-${generation}`,
                      cursor: 'cursor-terminal',
                      timestamp: new Date().toISOString(),
                      state: 'exited',
                      exit: { code: 0, timedOut: false }
                    });
                  }
                }),
              cancel: async () => {
                terminalOutputCancels.push(generation);
              },
              [Symbol.dispose]: () => {}
            };
          },
          hasActive: async () => false
        },
        ports: {}
      };
    }

    async connect() {
      this.connectionOpen = true;
    }

    async getRuntimeMetadata() {
      return {
        runtimeIncarnationID: `incarnation-${this.generation}`,
        sandboxVersion: '0.0.0',
        controlProtocolVersion: 1
      };
    }

    async activateControlSession(expectedRuntimeIncarnationID: string) {
      this.activated = true;
      return {
        runtimeIncarnationID: expectedRuntimeIncarnationID,
        sandboxVersion: '0.0.0',
        controlProtocolVersion: 1
      };
    }
  }
}));

import { Sandbox } from '../src/sandbox';

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

function runtimeRecord(id = 'runtime-a', incarnation = 'incarnation-0') {
  return {
    schemaVersion: 1,
    id,
    runtimeIncarnationID: incarnation
  };
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
      getTcpPort: vi.fn(() => ({ fetch: vi.fn() })),
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
  const sandbox = stub;

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
    terminalOutputCancels.length = 0;
    startAndWaitForPortsCalls.length = 0;
    physicalStops.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads runtime liveness without starting or creating a control connection', async () => {
    const { sandbox, ctx } = await createSandbox();
    await ctx.storage.put('currentRuntimeIdentity', runtimeRecord());

    await expect(sandbox.isRuntimeActive()).resolves.toBe(true);

    expect(ctx.container.start).not.toHaveBeenCalled();
    expect(startAndWaitForPortsCalls).toHaveLength(0);
    expect(connectionGenerations).toHaveLength(0);
    expect(rpcGenerations).toHaveLength(0);
  });

  it('completes inactivity expiry through one physical stop', async () => {
    const { sandbox, ctx } = await createSandbox();
    await ctx.storage.put('currentRuntimeIdentity', runtimeRecord());

    await expect(
      Promise.race([
        sandbox.onActivityExpired(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('activity expiry did not settle')),
            100
          )
        )
      ])
    ).resolves.toBeUndefined();

    expect(physicalStops).toHaveLength(1);
    expect(ctx.container.running).toBe(false);
  });

  it('holds exec and terminal creation behind a pending committed inactivity stop', async () => {
    const { sandbox, ctx } = await createSandbox();
    await ctx.storage.put('currentRuntimeIdentity', runtimeRecord());
    const stop = deferred();
    let stopCalled = false;
    vi.spyOn(
      Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
      'stop'
    ).mockImplementation(() => {
      stopCalled = true;
      return stop.promise;
    });

    const expiry = sandbox.onActivityExpired();
    await vi.waitFor(() => expect(stopCalled).toBe(true));
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
    expect(processStarts).toHaveLength(1);
    expect(terminalCreates).toHaveLength(1);
    expect(processStarts[0]).toBeGreaterThan(
      connectionGenerationsBeforeStopSettles.at(-1) ?? -1
    );
    expect(terminalCreates[0]).toBeGreaterThan(
      connectionGenerationsBeforeStopSettles.at(-1) ?? -1
    );
  });

  it('closes retained terminal output after terminal event', async () => {
    const { sandbox, ctx } = await createSandbox();
    await ctx.storage.put('currentRuntimeIdentity', runtimeRecord());

    const terminal = await sandbox.createTerminal({ command: ['sh'] });
    const subscription = await terminal.capability.openOutput({
      replay: true,
      follow: true
    });
    const first = await subscription.next();
    const second = await subscription.next();

    expect(first).toMatchObject({
      done: false,
      value: {
        type: 'terminal',
        state: 'exited',
        terminalId: terminal.snapshot.id
      }
    });
    expect(second).toEqual({ done: true, value: undefined });
    expect(terminalOutputCancels).toHaveLength(1);
  });

  it('holds exposePort startup behind a pending committed inactivity stop', async () => {
    const { sandbox, ctx } = await createSandbox();
    await ctx.storage.put('currentRuntimeIdentity', runtimeRecord());
    (sandbox as any).sandboxName = 'sandbox-activity-gate-test';
    const stop = deferred();
    let stopCalled = false;
    vi.spyOn(
      Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
      'stop'
    ).mockImplementation(() => {
      stopCalled = true;
      return stop.promise;
    });
    const expiry = sandbox.onActivityExpired();
    await vi.waitFor(() => expect(stopCalled).toBe(true));
    expect(ctx.container.start).not.toHaveBeenCalled();

    ctx.container.running = false;
    const exposed = sandbox.exposePort(8080, { hostname: 'example.com' });
    await Promise.resolve();

    expect(startAndWaitForPortsCalls).toHaveLength(0);
    expect(ctx.container.start).not.toHaveBeenCalled();

    stop.resolve();
    await expiry;
    await expect(exposed).resolves.toMatchObject({ port: 8080 });

    expect(startAndWaitForPortsCalls).toEqual([
      {
        ports: [3000],
        cancellationOptions: {
          instanceGetTimeoutMS: 30000,
          portReadyTimeoutMS: 90000,
          waitInterval: 300,
          abort: undefined
        }
      }
    ]);
    // ctx.container.start is called internally because our startAndWaitForPorts mock calls physicalStart()
    expect(ctx.container.start).toHaveBeenCalledTimes(1);
  });

  it('releases the gate operation count when post-stop startup fails so a retry can run', async () => {
    const { sandbox, ctx } = await createSandbox();
    await ctx.storage.put('currentRuntimeIdentity', runtimeRecord());
    const stop = deferred();
    let stopCalled = false;
    vi.spyOn(
      Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
      'stop'
    ).mockImplementation(() => {
      stopCalled = true;
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
