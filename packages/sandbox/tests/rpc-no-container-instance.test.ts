import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reproduces issue #794 end-to-end through a real Sandbox DO on the RPC
 * transport.
 *
 * In production the Containers platform raises
 *
 *   "There is no container instance that can be provided to this Durable
 *    Object, try again later"
 *
 * from the container binding when it cannot admit a container. On the RPC
 * transport the SDK reaches the container by issuing a WebSocket upgrade
 * `fetch()` against the DO itself, which flows into the base
 * `@cloudflare/containers` `Container.fetch()`. That is exactly where the
 * platform error is thrown, so we reproduce it by throwing the real message
 * from the mocked base-class `fetch()` on the WebSocket-upgrade path.
 *
 * Everything above that point is the real SDK stack: `sandbox.mkdir()` →
 * `ensureDefaultSession()` → `this.client.utils.createSession()` → real
 * `ContainerControlClient` → real `ContainerControlConnection` (real capnweb
 * `RpcSession` + `DeferredTransport`) → real `translateRPCError`.
 *
 * Before the fix this surfaced as a generic
 * `OPERATION_INTERRUPTED` ("utils.createSession was interrupted…"). The test
 * asserts the caller now receives a typed `ContainerUnavailableError`.
 */

const NO_INSTANCE_MESSAGE =
  'There is no container instance that can be provided to this Durable Object, try again later';

// Throwing switch so individual tests can pick which platform message the
// base container raises on the WebSocket-upgrade path.
let upgradeError: Error = new Error(NO_INSTANCE_MESSAGE);

vi.mock('@cloudflare/containers', () => {
  const mockSwitchPort = vi.fn((request: Request, port: number) => {
    const url = new URL(request.url);
    url.pathname = `/proxy/${port}${url.pathname}`;
    return new Request(url, request);
  });

  const MockContainer = class Container {
    ctx: any;
    env: any;
    sleepAfter: string | number = '10m';
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        // The container binding cannot admit an instance: throw the platform
        // error exactly as workerd does. This is the RPC upgrade path.
        throw upgradeError;
      }
      return new Response('Mock Container fetch');
    }
    async containerFetch(): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
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
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(): Promise<Response> {
      return new Response('Mock ContainerProxy fetch');
    }
  };

  return {
    Container: MockContainer,
    ContainerProxy: MockContainerProxy,
    getContainer: vi.fn(),
    switchPort: mockSwitchPort
  };
});

vi.mock('../src/interpreter', () => ({
  CodeInterpreter: class {
    constructor(_getInterpreter: unknown) {}
  }
}));

import { ContainerUnavailableError } from '../src/errors';
import { Sandbox } from '../src/sandbox';

function makeCtx() {
  const storageState = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => storageState.get(key) ?? null),
    put: vi.fn(async (key: string, value: unknown) => {
      storageState.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      storageState.delete(key);
    }),
    list: vi.fn().mockResolvedValue(new Map()),
    transaction: vi.fn(async (cb: (s: unknown) => unknown) => cb(storage))
  };
  return {
    storage,
    blockConcurrencyWhile: vi
      .fn()
      .mockImplementation(<T>(cb: () => Promise<T>): Promise<T> => cb()),
    waitUntil: vi.fn(),
    container: { running: false, start: vi.fn() },
    id: {
      toString: () => 'test-sandbox-id',
      equals: vi.fn(),
      name: 'test-sandbox'
    }
  };
}

async function makeRpcSandbox(): Promise<Sandbox> {
  const ctx = makeCtx();
  // SANDBOX_TRANSPORT=rpc forces the ContainerControlClient (RPC transport).
  const env = { SANDBOX_TRANSPORT: 'rpc' } as Record<string, unknown>;
  const sandbox = new Sandbox(
    ctx as unknown as ConstructorParameters<typeof Sandbox>[0],
    env
  );
  await vi.waitFor(() => {
    expect(ctx.blockConcurrencyWhile).toHaveBeenCalled();
  });
  await Promise.all(
    (ctx.blockConcurrencyWhile as any).mock.results.map(
      (r: { value: unknown }) => r.value
    )
  );
  // Fail fast: skip the upgrade retry budget so the platform error surfaces
  // on the first attempt instead of after ~2 minutes of backoff.
  sandbox.client.setRetryTimeoutMs(0);
  return sandbox;
}

describe('RPC transport: no container instance (issue #794)', () => {
  beforeEach(() => {
    upgradeError = new Error(NO_INSTANCE_MESSAGE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces ContainerUnavailableError from sandbox.mkdir() (not OPERATION_INTERRUPTED)', async () => {
    const sandbox = await makeRpcSandbox();

    let thrown: unknown;
    try {
      await sandbox.mkdir('/workspace', { recursive: true });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    const err = thrown as ContainerUnavailableError;
    expect(err.code).toBe('CONTAINER_UNAVAILABLE');
    expect(err.reason).toBe('no_container_instance_available');
    expect(err.context.retryable).toBe(true);
    expect(err.context.originalMessage).toContain(
      'no container instance that can be provided'
    );
    // Regression guard: the old behaviour masked this as an interrupted op.
    expect((err as Error).message).not.toContain('was interrupted');
  });

  it('surfaces ContainerUnavailableError from sandbox.exec() as well', async () => {
    const sandbox = await makeRpcSandbox();

    const thrown = await sandbox.exec('echo hi').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    expect((thrown as ContainerUnavailableError).reason).toBe(
      'no_container_instance_available'
    );
  });

  it('classifies the "max instances exceeded" platform message', async () => {
    upgradeError = new Error(
      'Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances'
    );
    const sandbox = await makeRpcSandbox();

    const thrown = await sandbox
      .mkdir('/workspace', { recursive: true })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    expect((thrown as ContainerUnavailableError).reason).toBe(
      'max_container_instances_exceeded'
    );
  });
});
