import type {
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  Logger,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelInfo
} from '@repo/shared';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeIdentityInactiveError } from '../src/current-runtime-identity';
import { ErrorCode, RPCTransportError } from '../src/errors';
import {
  createTunnelsHandler,
  pruneTunnelsForRestart,
  type TunnelsStorage
} from '../src/tunnels/tunnels-handler';

type RunQuickTunnelMock = Mock<
  (id: string, port: number) => Promise<TunnelInfo>
>;
type DestroyTunnelMock = Mock<(id: string) => Promise<unknown>>;
type ListTunnelsMock = Mock<() => Promise<TunnelInfo[]>>;
type EnsureTunnelRunMock = Mock<
  (request: EnsureTunnelRunRequest) => Promise<EnsureTunnelRunResult>
>;
type StopTunnelRunMock = Mock<
  (request: StopTunnelRunRequest) => Promise<StopTunnelRunResult>
>;

interface MockTunnelsClient {
  runQuickTunnel: RunQuickTunnelMock;
  destroyTunnel: DestroyTunnelMock;
  listTunnels: ListTunnelsMock;
  ensureTunnelRun: EnsureTunnelRunMock;
  stopTunnelRun: StopTunnelRunMock;
}

function makeLogger(): Logger {
  const log: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => log)
  } as unknown as Logger;
  return log;
}

function makeClient(): { client: { tunnels: MockTunnelsClient } } {
  return {
    client: {
      tunnels: {
        runQuickTunnel:
          vi.fn<(id: string, port: number) => Promise<TunnelInfo>>(),
        destroyTunnel: vi.fn<(id: string) => Promise<unknown>>(),
        listTunnels: vi.fn<() => Promise<TunnelInfo[]>>(),
        ensureTunnelRun:
          vi.fn<
            (request: EnsureTunnelRunRequest) => Promise<EnsureTunnelRunResult>
          >(),
        stopTunnelRun:
          vi.fn<
            (request: StopTunnelRunRequest) => Promise<StopTunnelRunResult>
          >()
      }
    }
  };
}

function makeStorage(initial?: Record<string, TunnelInfo>): TunnelsStorage {
  const data = new Map<string, unknown>();
  if (initial) data.set('tunnels', { ...initial });
  let txQueue: Promise<unknown> = Promise.resolve();
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, next: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(next)));
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    transaction: vi.fn((closure: (txn: unknown) => Promise<unknown>) => {
      const next = txQueue.then(() => closure(storage));
      txQueue = next.catch(() => undefined);
      return next;
    })
  } as unknown as TunnelsStorage;
  return storage;
}

function makeRuntimeFences(runtimeId = 'runtime-1') {
  const runtime = {
    id: runtimeId,
    owns: (record: { readonly runtimeIdentityID: string }) =>
      record.runtimeIdentityID === runtimeId,
    scope: <T extends object>(value: T) => ({
      ...value,
      runtimeIdentityID: runtimeId
    })
  };
  const lifetime = {
    id: 'lifetime-1',
    generation: 1,
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
    owns: (record: { readonly sandboxLifetimeID: string }) =>
      record.sandboxLifetimeID === 'lifetime-1',
    scope: <T extends object>(value: T) => ({
      ...value,
      sandboxLifetimeID: 'lifetime-1'
    })
  };

  return {
    runtime,
    lifetime,
    currentRuntime: {
      get: vi.fn<() => Promise<typeof runtime | null>>(async () => runtime),
      markStarted: vi.fn(async () => runtime),
      assertActive: vi.fn(async (_runtime: typeof runtime) => {})
    },
    currentLifetime: {
      getOrCreate: vi.fn(async () => lifetime),
      assertCurrent: vi.fn(async () => {})
    }
  };
}

function makeRecord(overrides: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 'quick-0123456789abcdef',
    port: 8080,
    url: 'https://stub.trycloudflare.com',
    hostname: 'stub.trycloudflare.com',
    createdAt: '2026-05-13T00:00:00.000Z',
    ...overrides
  };
}

function createDisposedRPCError(): RPCTransportError {
  return new RPCTransportError({
    code: ErrorCode.RPC_TRANSPORT_ERROR,
    message: 'RPC session was shut down by disposing the main stub',
    httpStatus: 503,
    context: {
      kind: 'session_disposed',
      originalMessage: 'RPC session was shut down by disposing the main stub',
      errorName: 'Error'
    },
    timestamp: '2026-05-13T00:00:00.000Z'
  });
}

function makeHandler() {
  const { client } = makeClient();
  const storage = makeStorage();
  const fences = makeRuntimeFences();
  const { tunnels } = createTunnelsHandler({
    client: client as unknown as Parameters<
      typeof createTunnelsHandler
    >[0]['client'],
    storage,
    logger: makeLogger(),
    currentRuntime: fences.currentRuntime,
    currentLifetime: fences.currentLifetime
  } as unknown as Parameters<typeof createTunnelsHandler>[0]);
  return { client, storage, handler: tunnels, fences };
}

describe('tunnels handler > quick lifecycle recovery', () => {
  it('uses ensureTunnelRun and stores runtime metadata for quick tunnels', async () => {
    const { client, storage, handler } = makeHandler();
    client.tunnels.ensureTunnelRun.mockImplementation(async (request) => ({
      started: true,
      run: {
        tunnelId: request.tunnelId,
        runId: request.runId,
        mode: 'quick',
        port: request.port,
        url: 'https://fresh.trycloudflare.com',
        hostname: 'fresh.trycloudflare.com',
        startedAt: '2026-05-13T00:00:00.000Z'
      }
    }));

    const info = await handler.get(8080);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    expect(client.tunnels.runQuickTunnel).not.toHaveBeenCalled();
    const request = client.tunnels.ensureTunnelRun.mock.calls[0][0];
    expect(info).toMatchObject({
      id: request.tunnelId,
      port: 8080,
      url: 'https://fresh.trycloudflare.com',
      hostname: 'fresh.trycloudflare.com'
    });
    const meta = await storage.get<Record<string, unknown>>('tunnels:meta');
    expect(meta?.['8080']).toMatchObject({
      optionsHash: 'v1:quick',
      runtimeIdentityID: 'runtime-1',
      sandboxLifetimeID: 'lifetime-1',
      tunnelRunId: request.runId
    });
  });

  it('retries quick tunnel provisioning when runtime replacement is detected before commit', async () => {
    const { client, storage, handler, fences } = makeHandler();
    client.tunnels.ensureTunnelRun.mockImplementation(async (request) => ({
      started: true,
      run: {
        tunnelId: request.tunnelId,
        runId: request.runId,
        mode: 'quick',
        port: request.port,
        url: `https://${request.runId}.trycloudflare.com`,
        hostname: `${request.runId}.trycloudflare.com`,
        startedAt: '2026-05-13T00:00:00.000Z'
      }
    }));
    fences.currentRuntime.assertActive
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RuntimeIdentityInactiveError())
      .mockResolvedValue(undefined);

    const info = await handler.get(8080);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    const secondRunId = client.tunnels.ensureTunnelRun.mock.calls[1][0].runId;
    expect(info.hostname).toBe(`${secondRunId}.trycloudflare.com`);
    const stored = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(stored?.['8080']).toEqual(info);
  });

  it('captures runtime before quick tunnel admission so a replacement during spawn retries', async () => {
    const { client, storage, handler, fences } = makeHandler();
    let activeRuntimeId = 'runtime-1';
    const makeRuntime = (id: string) => ({
      id,
      owns: (record: { readonly runtimeIdentityID: string }) =>
        record.runtimeIdentityID === id,
      scope: <T extends object>(value: T) => ({
        ...value,
        runtimeIdentityID: id
      })
    });
    fences.currentRuntime.get.mockImplementation(async () =>
      makeRuntime(activeRuntimeId)
    );
    fences.currentRuntime.assertActive.mockImplementation(async (runtime) => {
      if (runtime.id !== activeRuntimeId) {
        throw new RuntimeIdentityInactiveError();
      }
    });
    client.tunnels.ensureTunnelRun.mockImplementation(async (request) => {
      if (client.tunnels.ensureTunnelRun.mock.calls.length === 1) {
        activeRuntimeId = 'runtime-2';
      }
      return {
        started: true,
        run: {
          tunnelId: request.tunnelId,
          runId: request.runId,
          mode: 'quick',
          port: request.port,
          url: `https://${request.runId}.trycloudflare.com`,
          hostname: `${request.runId}.trycloudflare.com`,
          startedAt: '2026-05-13T00:00:00.000Z'
        }
      };
    });

    const info = await handler.get(8080);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    const staleRunId = client.tunnels.ensureTunnelRun.mock.calls[0][0].runId;
    const currentRunId = client.tunnels.ensureTunnelRun.mock.calls[1][0].runId;
    expect(info.hostname).toBe(`${currentRunId}.trycloudflare.com`);
    expect(info.hostname).not.toBe(`${staleRunId}.trycloudflare.com`);
    const meta =
      await storage.get<Record<string, { runtimeIdentityID: string }>>(
        'tunnels:meta'
      );
    expect(meta?.['8080'].runtimeIdentityID).toBe('runtime-2');
  });

  it('replays the same quick tunnel run identity after response-loss interruption', async () => {
    const { client, handler } = makeHandler();
    client.tunnels.ensureTunnelRun
      .mockRejectedValueOnce(createDisposedRPCError())
      .mockImplementationOnce(async (request) => ({
        started: false,
        run: {
          tunnelId: request.tunnelId,
          runId: request.runId,
          mode: 'quick',
          port: request.port,
          url: `https://${request.runId}.trycloudflare.com`,
          hostname: `${request.runId}.trycloudflare.com`,
          startedAt: '2026-05-13T00:00:00.000Z'
        }
      }));

    const info = await handler.get(8080);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    const first = client.tunnels.ensureTunnelRun.mock.calls[0][0];
    const second = client.tunnels.ensureTunnelRun.mock.calls[1][0];
    expect(second).toMatchObject({
      tunnelId: first.tunnelId,
      runId: first.runId,
      mode: 'quick',
      port: 8080
    });
    expect(info.hostname).toBe(`${first.runId}.trycloudflare.com`);
  });

  it('serializes concurrent quick tunnel gets across response-loss recovery', async () => {
    const { client, handler } = makeHandler();
    const firstAdmission = Promise.withResolvers<EnsureTunnelRunResult>();
    client.tunnels.ensureTunnelRun
      .mockReturnValueOnce(firstAdmission.promise)
      .mockImplementation(async (request) => ({
        started: false,
        run: {
          tunnelId: request.tunnelId,
          runId: request.runId,
          mode: 'quick',
          port: request.port,
          url: `https://${request.runId}.trycloudflare.com`,
          hostname: `${request.runId}.trycloudflare.com`,
          startedAt: '2026-05-13T00:00:00.000Z'
        }
      }));

    const firstGet = handler.get(8080);
    await vi.waitFor(() => {
      expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    });

    const secondGet = handler.get(8080);
    await Promise.resolve();
    firstAdmission.reject(createDisposedRPCError());

    const [first, second] = await Promise.all([firstGet, secondGet]);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    const firstCall = client.tunnels.ensureTunnelRun.mock.calls[0][0];
    const replayCall = client.tunnels.ensureTunnelRun.mock.calls[1][0];
    expect(replayCall).toMatchObject({
      tunnelId: firstCall.tunnelId,
      runId: firstCall.runId
    });
    expect(second).toEqual(first);
  });

  it('admits a quick tunnel run before asserting that a cold runtime is active', async () => {
    const { client, handler, fences } = makeHandler();
    const runtime = fences.runtime;
    fences.currentRuntime.get.mockImplementationOnce(async () => null);
    fences.currentRuntime.markStarted.mockResolvedValueOnce(runtime);
    let admitted = false;
    fences.currentRuntime.assertActive.mockImplementation(async () => {
      if (!admitted) {
        throw new RuntimeIdentityInactiveError();
      }
    });
    client.tunnels.ensureTunnelRun.mockImplementation(async (request) => {
      admitted = true;
      return {
        started: true,
        run: {
          tunnelId: request.tunnelId,
          runId: request.runId,
          mode: 'quick',
          port: request.port,
          url: 'https://cold.trycloudflare.com',
          hostname: 'cold.trycloudflare.com',
          startedAt: '2026-05-13T00:00:00.000Z'
        }
      };
    });

    await expect(handler.get(8080)).resolves.toMatchObject({
      hostname: 'cold.trycloudflare.com'
    });
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
  });

  it('surfaces OPERATION_INTERRUPTED and leaves storage empty after quick tunnel recovery exhaustion', async () => {
    const { client, storage, handler, fences } = makeHandler();
    client.tunnels.ensureTunnelRun.mockImplementation(async (request) => ({
      started: true,
      run: {
        tunnelId: request.tunnelId,
        runId: request.runId,
        mode: 'quick',
        port: request.port,
        url: `https://${request.runId}.trycloudflare.com`,
        hostname: `${request.runId}.trycloudflare.com`,
        startedAt: '2026-05-13T00:00:00.000Z'
      }
    }));
    let assertActiveCalls = 0;
    fences.currentRuntime.assertActive.mockImplementation(async () => {
      assertActiveCalls += 1;
      if (assertActiveCalls % 2 === 0) {
        throw new RuntimeIdentityInactiveError();
      }
    });

    await expect(handler.get(8080)).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: {
        reason: 'recovery_exhausted',
        operation: 'tunnel.get',
        phase: 'interrupted',
        admitted: true,
        retryable: false,
        recoveryAttempts: 2,
        maxRecoveryAttempts: 2
      }
    });

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(3);
    expect(await storage.get<Record<string, TunnelInfo>>('tunnels')).toEqual(
      {}
    );
  });
});

describe('TunnelsHandler public surface', () => {
  it('does not expose any exit hook on the public interface', () => {
    const { client } = makeClient();
    const { tunnels, handleTunnelExit } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage: makeStorage(),
      logger: makeLogger()
    } as unknown as Parameters<typeof createTunnelsHandler>[0]);
    expect(handleTunnelExit).toBeTypeOf('function');
    expect('handleTunnelExit' in (tunnels as unknown as object)).toBe(false);
  });
});

describe('route-based SandboxClient.tunnels placeholder', () => {
  it('throws "RPC transport required" from any method on the proxy', async () => {
    const { SandboxClient } = await import('../src/clients/sandbox-client');
    const client = new SandboxClient({ baseUrl: 'http://test.invalid' });
    expect(() =>
      (client.tunnels as unknown as { get: () => void }).get()
    ).toThrow(/RPC transport/);
    expect(() =>
      (client.tunnels as unknown as { list: () => void }).list()
    ).toThrow(/RPC transport/);
    expect(() =>
      (client.tunnels as unknown as { destroy: () => void }).destroy()
    ).toThrow(/RPC transport/);
  });
});

describe('pruneTunnelsForRestart', () => {
  it('drops quick-tunnel entries and marks named ones for respawn', async () => {
    const quick = makeRecord({ id: 'quick-1', port: 8080 });
    const named = makeRecord({
      id: 'named-1',
      port: 9090,
      name: 'app',
      hostname: 'app.example.com',
      url: 'https://app.example.com'
    });
    const storage = makeStorage({ '8080': quick, '9090': named });
    await storage.put('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick' },
      '9090': {
        optionsHash: 'v1:named:app',
        dnsRecordId: 'dns-1',
        accountId: 'acct',
        zoneId: 'zone'
      }
    });

    await pruneTunnelsForRestart(storage);

    expect(await storage.get('tunnels')).toEqual({ '9090': named });
    expect(await storage.get('tunnels:meta')).toEqual({
      '9090': {
        optionsHash: 'v1:named:app',
        dnsRecordId: 'dns-1',
        accountId: 'acct',
        zoneId: 'zone',
        needsRespawn: true
      }
    });
  });

  it('is a no-op on empty storage', async () => {
    const storage = makeStorage();

    await pruneTunnelsForRestart(storage);

    expect(await storage.get('tunnels')).toEqual({});
    expect(await storage.get('tunnels:meta')).toEqual({});
  });
});
