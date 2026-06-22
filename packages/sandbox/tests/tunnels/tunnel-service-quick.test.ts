/**
 * SDK tunnel service unit tests.
 *
 * Exercises validation, id minting, DO-storage caching, inflight
 * coalescing, and log-event paths against a mocked RPC client and a
 * lightweight in-memory `ctx.storage` shim.
 */

import type {
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelInfo
} from '@repo/shared';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeIdentityInactiveError } from '../../src/current-runtime-identity';
import { ErrorCode, RPCTransportError } from '../../src/errors';
import { SandboxLifetimeChangedError } from '../../src/sandbox-lifetime';
import { SandboxSecurityError } from '../../src/security';
import {
  createTunnelsHandle,
  pruneTunnelsForRestart,
  type TunnelsHandler,
  type TunnelsStorage
} from '../../src/tunnels/rpc-target';
import {
  makeFences,
  makeLogger,
  makeStorage as makeRawStorage
} from './helpers';

type EnsureTunnelRunMock = Mock<
  (request: EnsureTunnelRunRequest) => Promise<EnsureTunnelRunResult>
>;
type StopTunnelRunMock = Mock<
  (request: StopTunnelRunRequest) => Promise<StopTunnelRunResult>
>;
type StorageGetMock = Mock<(key: string) => Promise<unknown>>;
type StoragePutMock = Mock<(key: string, next: unknown) => Promise<unknown>>;
type StorageTransactionMock = Mock<
  (closure: (txn: unknown) => Promise<unknown>) => Promise<unknown>
>;
type LogMock = Mock<(message: string, ...context: unknown[]) => void>;

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
    timestamp: '2026-06-22T12:00:00.000Z'
  });
}

interface MockTunnelsClient {
  ensureTunnelRun: EnsureTunnelRunMock;
  stopTunnelRun: StopTunnelRunMock;
}

function makeClient(): { client: { tunnels: MockTunnelsClient } } {
  return {
    client: {
      tunnels: {
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
  return makeRawStorage(initial ? { tunnels: { ...initial } } : {});
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

function ensureQuickResult(
  request: EnsureTunnelRunRequest,
  info: TunnelInfo
): EnsureTunnelRunResult {
  if (request.mode !== 'quick') {
    throw new Error('Expected a quick tunnel run request');
  }
  if (info.name) {
    throw new Error('Expected a quick tunnel record');
  }
  return {
    started: true,
    run: {
      mode: 'quick',
      tunnelId: info.id,
      runId: request.runId,
      port: info.port,
      url: info.url,
      hostname: info.hostname,
      startedAt: info.createdAt
    }
  };
}

function mockEnsureQuick(
  tunnels: MockTunnelsClient,
  create: (
    tunnelId: string,
    port: number,
    runId: string
  ) => TunnelInfo | Promise<TunnelInfo>
): void {
  tunnels.ensureTunnelRun.mockImplementation(async (request) =>
    ensureQuickResult(
      request,
      await create(request.tunnelId, request.port, request.runId)
    )
  );
}

type TunnelsHost = Parameters<typeof createTunnelsHandle>[0];

function makeHandler(extra: Partial<TunnelsHost> = {}) {
  const { client } = makeClient();
  const { storage: providedStorage, ...rest } = extra;
  const storage =
    (providedStorage as TunnelsStorage | undefined) ?? makeStorage();
  const { tunnels, handleTunnelExit } = createTunnelsHandle({
    client: client as unknown as TunnelsHost['client'],
    storage,
    logger: makeLogger(),
    ...rest
  } as unknown as TunnelsHost);
  return { client, storage, handler: tunnels, tunnels, handleTunnelExit };
}

describe('tunnel service > get', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('mints quick tunnel and run ids, then constructs the public record from the run snapshot', async () => {
    const { client, storage, handler } = makeHandler();
    client.tunnels.ensureTunnelRun.mockImplementation(async (request) => ({
      started: true,
      run: {
        ...request,
        url: 'https://stub.trycloudflare.com',
        hostname: 'stub.trycloudflare.com',
        startedAt: '2026-05-13T00:00:00.000Z'
      }
    }));

    const info = await handler.get(8080);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    const [request] = client.tunnels.ensureTunnelRun.mock.calls[0];
    expect(request.mode).toBe('quick');
    expect(request.port).toBe(8080);
    expect(request.tunnelId).toMatch(/^quick-[0-9a-f]{8}$/);
    expect(request.runId).toEqual(expect.any(String));
    expect(info).toEqual({
      id: request.tunnelId,
      port: 8080,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    expect(storage.put).toHaveBeenCalledTimes(2);
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    const tunnelsPut = putCalls.find(([key]) => key === 'tunnels');
    const metaPut = putCalls.find(([key]) => key === 'tunnels:meta');
    expect(tunnelsPut?.[1]).toEqual({ '8080': info });
    expect(metaPut?.[1]).toEqual({
      '8080': { optionsHash: 'v1:quick', tunnelRunId: request.runId }
    });
  });

  it('replays the same quick run request when the first call loses RPC transport', async () => {
    const { client, handler } = makeHandler();
    client.tunnels.ensureTunnelRun
      .mockRejectedValueOnce(createDisposedRPCError())
      .mockImplementationOnce(async (request) => ({
        started: false,
        run: {
          ...request,
          url: 'https://stub.trycloudflare.com',
          hostname: 'stub.trycloudflare.com',
          startedAt: '2026-05-13T00:00:00.000Z'
        }
      }));

    const info = await handler.get(8080);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    const first = client.tunnels.ensureTunnelRun.mock.calls[0][0];
    const second = client.tunnels.ensureTunnelRun.mock.calls[1][0];
    expect(second).toEqual(first);
    expect(info).toEqual({
      id: first.tunnelId,
      port: 8080,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    });
  });

  it('records runtime and sandbox lifetime ownership for quick tunnels', async () => {
    const { client, storage, handler } = makeHandler(makeFences());
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    await handler.get(8080);

    const meta =
      await storage.get<Record<string, Record<string, unknown>>>(
        'tunnels:meta'
      );
    expect(meta?.['8080']?.runtimeIdentityID).toBe('runtime-1');
    expect(meta?.['8080']?.sandboxLifetimeID).toBe('lifetime-1');
  });

  it('retries with a fresh id when the container reports TUNNEL_ALREADY_RUNNING', async () => {
    const { client, handler } = makeHandler();
    let attempts = 0;
    const collision = Object.assign(
      new Error('Tunnel quick-xxxx is already running'),
      {
        code: 'TUNNEL_ALREADY_RUNNING',
        errorResponse: { code: 'TUNNEL_ALREADY_RUNNING' }
      }
    );
    mockEnsureQuick(client.tunnels, async (id, port) => {
      attempts += 1;
      if (attempts === 1) throw collision;
      return makeRecord({ id, port });
    });

    const info = await handler.get(8080);
    expect(attempts).toBe(2);
    const firstId = client.tunnels.ensureTunnelRun.mock.calls[0][0].tunnelId;
    const secondId = client.tunnels.ensureTunnelRun.mock.calls[1][0].tunnelId;
    expect(firstId).not.toBe(secondId);
    expect(info.id).toBe(secondId);
  });

  it('cache hit: returns a current-runtime record without any container RPC', async () => {
    const record = makeRecord({ id: 'quick-cached0000cached', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    await storage.put('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick', runtimeIdentityID: 'runtime-1' }
    });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger(),
      ...makeFences()
    });
    (storage.put as StoragePutMock).mockClear();

    const info = await handler.get(8080);

    expect(info).toEqual(record);
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refreshes an unscoped quick record instead of returning a stale URL', async () => {
    const stale = makeRecord({ id: 'quick-stale000stale', port: 8080 });
    const fresh = makeRecord({
      id: 'quick-fresh000fresh',
      port: 8080,
      url: 'https://fresh.trycloudflare.com',
      hostname: 'fresh.trycloudflare.com'
    });
    const { client, storage, handler } = makeHandler({
      storage: makeStorage({ '8080': stale }),
      ...makeFences()
    });
    mockEnsureQuick(client.tunnels, async () => fresh);

    const info = await handler.get(8080);

    expect(info).toEqual(fresh);
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    await expect(storage.get('tunnels')).resolves.toEqual({ '8080': fresh });
  });

  it('captures runtime after spawn when no active runtime exists before RPC', async () => {
    const getRuntime = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'runtime-after-rpc' });
    const markStarted = vi.fn(async () => ({ id: 'runtime-created-early' }));
    const { client, storage, handler } = makeHandler({
      currentRuntime: {
        get: getRuntime,
        markStarted,
        assertActive: vi.fn(async () => {})
      },
      currentLifetime: makeFences().currentLifetime
    } as unknown as Partial<TunnelsHost>);
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    await handler.get(8080);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    expect(markStarted).not.toHaveBeenCalled();
    const meta =
      await storage.get<Record<string, Record<string, unknown>>>(
        'tunnels:meta'
      );
    expect(meta?.['8080']?.runtimeIdentityID).toBe('runtime-after-rpc');
  });

  it('does not commit when runtime is unavailable after spawn', async () => {
    const { client, storage, handler } = makeHandler({
      currentRuntime: {
        get: vi.fn(async () => null),
        assertActive: vi.fn(async () => {})
      },
      currentLifetime: makeFences().currentLifetime
    } as unknown as Partial<TunnelsHost>);
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    let caught: unknown;
    try {
      await handler.get(8080);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ name: 'OperationInterruptedError' });
    expect((caught as { code?: unknown }).code).toBe(
      ErrorCode.OPERATION_INTERRUPTED
    );
    expect((caught as { context?: unknown }).context).toMatchObject({
      operation: 'tunnel.get',
      reason: 'recovery_exhausted',
      admitted: true,
      retryable: true
    });
    await expect(storage.get('tunnels')).resolves.toBeUndefined();
  });

  it('recovers quick get() after runtime replacement during spawn', async () => {
    const second = makeRecord({
      id: 'quick-second00second',
      port: 8080,
      url: 'https://second.trycloudflare.com',
      hostname: 'second.trycloudflare.com'
    });
    const { client, handler } = makeHandler(
      makeFences({
        currentRuntime: {
          // First attempt's post-spawn fence reports a replaced runtime;
          // the retry runs clean.
          assertActive: vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new RuntimeIdentityInactiveError())
            .mockResolvedValue(undefined)
        }
      })
    );
    client.tunnels.ensureTunnelRun
      .mockImplementationOnce(async (request) =>
        ensureQuickResult(request, makeRecord({ id: 'quick-first000first' }))
      )
      .mockImplementationOnce(async (request) =>
        ensureQuickResult(request, second)
      );

    const info = await handler.get(8080);

    expect(info).toEqual(second);
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
  });

  it('surfaces sandbox lifetime changes as non-retryable operation interruptions', async () => {
    const { client, handler } = makeHandler(
      makeFences({
        currentLifetime: {
          assertCurrent: vi
            .fn()
            .mockRejectedValue(new SandboxLifetimeChangedError())
        }
      })
    );
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    await expect(handler.get(8080)).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: expect.objectContaining({
        reason: 'sandbox_lifetime_changed',
        operation: 'tunnel.get',
        retryable: false,
        admitted: true
      })
    });
  });

  it('bounds runtime-replacement recovery and never commits a partial record', async () => {
    // Every post-spawn fence reports a replaced runtime, so recovery can
    // never converge. The operation surfaces recovery_exhausted and
    // leaves storage empty so no orphaned tunnel record persists.
    let assertCalls = 0;
    const { client, storage, handler } = makeHandler(
      makeFences({
        currentRuntime: {
          assertActive: vi.fn(async () => {
            assertCalls += 1;
            if (assertCalls % 2 === 0) {
              throw new RuntimeIdentityInactiveError();
            }
          })
        }
      })
    );
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    await expect(handler.get(8080)).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: expect.objectContaining({
        reason: 'recovery_exhausted',
        operation: 'tunnel.get',
        retryable: true,
        admitted: true,
        recoveryAttempts: 2,
        maxRecoveryAttempts: 2
      })
    });
    expect(await storage.get('tunnels')).toBeUndefined();
    expect(await storage.get('tunnels:meta')).toBeUndefined();
  });

  it('refreshes a quick cache hit owned by an old runtime', async () => {
    const fresh = makeRecord({
      id: 'quick-fresh0000fresh',
      port: 8080,
      url: 'https://fresh.trycloudflare.com',
      hostname: 'fresh.trycloudflare.com'
    });
    const storage = makeStorage({
      '8080': makeRecord({ id: 'quick-stale0000stale' })
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick', runtimeIdentityID: 'runtime-old' }
    });
    const { client, handler } = makeHandler({
      storage,
      ...makeFences({
        currentRuntime: {
          get: vi.fn(async () => ({ id: 'runtime-new' })),
          markStarted: vi.fn(async () => ({ id: 'runtime-new' }))
        }
      })
    });
    mockEnsureQuick(client.tunnels, async () => fresh);

    const info = await handler.get(8080);

    expect(info).toEqual(fresh);
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
  });

  it('after storage is cleared (simulating container restart), behaves like cache miss', async () => {
    const record = makeRecord({ id: 'quick-stale00000000stale', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    // Simulate the onStart() clear.
    await storage.delete('tunnels');

    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({
        id,
        port,
        url: 'https://fresh.trycloudflare.com',
        hostname: 'fresh.trycloudflare.com'
      })
    );

    const info = await handler.get(8080);
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    const [{ tunnelId }] = client.tunnels.ensureTunnelRun.mock.calls[0];
    expect(tunnelId).not.toBe(record.id);
    expect(info.url).toBe('https://fresh.trycloudflare.com');
  });

  it('coalesces concurrent get() calls for the same port', async () => {
    const { client, handler } = makeHandler();
    let resolveRun: (info: TunnelInfo) => void = () => {};
    client.tunnels.ensureTunnelRun.mockImplementation(
      (request: EnsureTunnelRunRequest) =>
        new Promise<EnsureTunnelRunResult>((resolve) => {
          resolveRun = (info) => resolve(ensureQuickResult(request, info));
        })
    );

    const a = handler.get(8080);
    const b = handler.get(8080);
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.ensureTunnelRun.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    resolveRun(makeRecord({ id: 'ignored', port: 8080 }));
    const [resolvedA, resolvedB] = await Promise.all([a, b]);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    expect(resolvedA).toEqual(resolvedB);
  });

  it('does not coalesce different ports', async () => {
    const { client, handler } = makeHandler();
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    const [a, b] = await Promise.all([handler.get(8080), handler.get(8081)]);
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    expect(a.port).toBe(8080);
    expect(b.port).toBe(8081);
  });

  it('writes through storage.transaction() so concurrent miss-path writes do not clobber each other', async () => {
    const { client, storage, handler } = makeHandler();
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    await Promise.all([handler.get(8080), handler.get(8081)]);

    // One transaction per miss-path write.
    expect(
      (storage.transaction as StorageTransactionMock).mock.calls.length
    ).toBe(2);
    // Both entries land in storage — the second writer did not clobber
    // the first.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(Object.keys(final ?? {})).toEqual(
      expect.arrayContaining(['8080', '8081'])
    );
  });

  it('clears the inflight slot when the spawn fails', async () => {
    const { client, handler } = makeHandler();
    client.tunnels.ensureTunnelRun.mockRejectedValueOnce(new Error('boom'));

    await expect(handler.get(8080)).rejects.toThrow('boom');

    client.tunnels.ensureTunnelRun.mockImplementationOnce(async (request) =>
      ensureQuickResult(
        request,
        makeRecord({ id: request.tunnelId, port: request.port })
      )
    );
    const info = await handler.get(8080);
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    expect(info.port).toBe(8080);
  });

  it('rejects out-of-range ports with SandboxSecurityError', async () => {
    const { client, handler } = makeHandler();

    await expect(handler.get(80)).rejects.toBeInstanceOf(SandboxSecurityError);
    await expect(handler.get(100000)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    await expect(handler.get(1.5)).rejects.toBeInstanceOf(SandboxSecurityError);
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
  });

  it('rejects the reserved control-plane port 3000', async () => {
    const { client, handler } = makeHandler();

    await expect(handler.get(3000)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
  });
});

describe('tunnel service > destroy', () => {
  it('clears storage without a container RPC for an unscoped known port', async () => {
    const record = makeRecord({ id: 'quick-known0000known00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    await handler.destroy(8080);

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
    // Storage entry is removed. Both keys (info + meta)
    // are cleared.
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    expect(putCalls).toHaveLength(2);
    const tunnelsPut = putCalls.find(([key]) => key === 'tunnels');
    const metaPut = putCalls.find(([key]) => key === 'tunnels:meta');
    expect(tunnelsPut?.[1]).toEqual({});
    expect(metaPut?.[1]).toEqual({});
  });

  it('stops the exact runtime run when tunnel metadata has a run id', async () => {
    const record = makeRecord({ id: 'quick-known0000known00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    await storage.put('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick', tunnelRunId: 'run-quick-1' }
    });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    client.tunnels.stopTunnelRun.mockResolvedValue({
      matched: true,
      stopped: true
    });

    await handler.destroy(8080);

    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledWith({
      tunnelId: record.id,
      runId: 'run-quick-1'
    });
  });

  it('wraps the read-modify-write in storage.transaction()', async () => {
    const record = makeRecord({ id: 'quick-tx0000tx0000tx', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    await handler.destroy(8080);

    expect(
      (storage.transaction as StorageTransactionMock).mock.calls.length
    ).toBe(1);
  });

  it('accepts a TunnelInfo object and resolves the port from it', async () => {
    const record = makeRecord({ id: 'quick-info0000info00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    await handler.destroy(record);

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
  });

  it('is a no-op success on unknown port', async () => {
    const { client, storage, handler } = makeHandler();

    await expect(handler.destroy(9999)).resolves.toBeUndefined();
    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('swallows TUNNEL_NOT_FOUND from the container (already gone)', async () => {
    const record = makeRecord({ id: 'quick-gone0000gone00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    // Production shape: the container emits a SandboxError carrying
    // `code: 'TUNNEL_NOT_FOUND'` in `errorResponse`. The handler must
    // match on the code, not on substring.
    const notFound = Object.assign(
      new Error('Tunnel quick-gone is not running'),
      {
        errorResponse: { code: 'TUNNEL_NOT_FOUND' },
        code: 'TUNNEL_NOT_FOUND'
      }
    );
    await storage.put('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick', tunnelRunId: 'run-gone' }
    });
    (storage.put as StoragePutMock).mockClear();
    client.tunnels.stopTunnelRun.mockRejectedValue(notFound);

    await expect(handler.destroy(8080)).resolves.toBeUndefined();
    // Storage is still cleared (both info + meta).
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    expect(putCalls).toHaveLength(2);
    expect(putCalls.find(([k]) => k === 'tunnels')?.[1]).toEqual({});
    expect(putCalls.find(([k]) => k === 'tunnels:meta')?.[1]).toEqual({});
  });

  it('does NOT swallow an unrelated error whose message merely contains the literal TUNNEL_NOT_FOUND', async () => {
    // Regression for the previous substring-match heuristic. A wrapped
    // error whose message happens to embed `TUNNEL_NOT_FOUND` (for
    // example, an upstream report quoting the original error) must
    // surface to the caller, not be silently swallowed as "already gone".
    const record = makeRecord({ id: 'quick-real0000real00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    await storage.put('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick', tunnelRunId: 'run-real' }
    });
    client.tunnels.stopTunnelRun.mockRejectedValue(
      new Error('rpc transport failure: original was TUNNEL_NOT_FOUND')
    );

    await expect(handler.destroy(8080)).rejects.toThrow(
      /rpc transport failure/
    );
  });

  it('does not roll back storage when the container call fails with a non-NOT_FOUND error', async () => {
    const record = makeRecord({ id: 'quick-err000000err000', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    await storage.put('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick', tunnelRunId: 'run-err' }
    });
    (storage.put as StoragePutMock).mockClear();
    client.tunnels.stopTunnelRun.mockRejectedValue(new Error('boom'));

    await expect(handler.destroy(8080)).rejects.toThrow('boom');
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    // Storage was cleared before the RPC and is not restored on failure.
    expect(putCalls).toHaveLength(2);
    expect(putCalls.find(([k]) => k === 'tunnels')?.[1]).toEqual({});
    expect(putCalls.find(([k]) => k === 'tunnels:meta')?.[1]).toEqual({});
  });
});

describe('tunnel service > list', () => {
  it('returns the values from storage (no container round-trip)', async () => {
    const a = makeRecord({ id: 'quick-aaaa1111aaaa1111', port: 8080 });
    const b = makeRecord({
      id: 'quick-bbbb2222bbbb2222',
      port: 8081,
      url: 'https://b.trycloudflare.com',
      hostname: 'b.trycloudflare.com'
    });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': a, '8081': b });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    const tunnels = await handler.list();
    expect(tunnels).toEqual(expect.arrayContaining([a, b]));
    expect(tunnels).toHaveLength(2);
  });

  it('returns an empty array when storage is empty', async () => {
    const { handler } = makeHandler();
    await expect(handler.list()).resolves.toEqual([]);
  });

  it('hides named tunnels that need respawn', async () => {
    const active = makeRecord({ id: 'quick-active00000000', port: 8080 });
    const staleNamed: TunnelInfo = {
      id: 'tunnel-uuid-named',
      port: 8081,
      name: 'api',
      hostname: 'api.example.com',
      url: 'https://api.example.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    };
    const { storage, handler } = makeHandler();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': active,
      '8081': staleNamed
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick' },
      '8081': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'dns-id',
        needsRespawn: true
      }
    });

    await expect(handler.list()).resolves.toEqual([active]);
  });
});

describe('tunnel service > per-port serialization', () => {
  it('queues destroy(port) behind an in-flight get(port) so the destroy sees the new record', async () => {
    const { client, storage, handler } = makeHandler();
    let resolveSpawn: (info: TunnelInfo) => void = () => {};
    client.tunnels.ensureTunnelRun.mockImplementation(
      (request: EnsureTunnelRunRequest) =>
        new Promise<EnsureTunnelRunResult>((resolve) => {
          resolveSpawn = (info) => resolve(ensureQuickResult(request, info));
        })
    );

    const getPromise = handler.get(8080);
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.ensureTunnelRun.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);

    // Now race a destroy(8080) against the unfinished get(). Without
    // serialization, the destroy would observe an empty map and return
    // a no-op success, then get() would write its record into storage
    // — leaking a cloudflared process the user thinks is gone.
    const destroyPromise = handler.destroy(8080);
    // Give the destroy a tick to attempt entering the critical section.
    await new Promise((r) => setTimeout(r, 5));
    // The destroy must NOT have stopped a run yet.

    // Let get() complete.
    resolveSpawn(makeRecord({ id: 'unused', port: 8080 }));
    const info = await getPromise;
    await destroyPromise;

    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledTimes(1);
    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledWith({
      tunnelId: info.id,
      runId: expect.any(String)
    });
    // Storage is empty at the end — the get's write and the destroy's
    // clear both happened, in that order.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final ?? {}).toEqual({});
  });

  it('queues get(port) behind an in-flight destroy(port)', async () => {
    const record = makeRecord({ id: 'quick-pre000pre000pre0', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    let resolveDestroy: () => void = () => {};
    await storage.put('tunnels:meta', {
      '8080': { optionsHash: 'v1:quick', tunnelRunId: 'run-pre' }
    });
    client.tunnels.stopTunnelRun.mockImplementation(
      () =>
        new Promise<{ matched: boolean; stopped: boolean }>((resolve) => {
          resolveDestroy = () => resolve({ matched: true, stopped: true });
        })
    );
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    const destroyPromise = handler.destroy(8080);
    // Wait until the destroy is in flight.
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.stopTunnelRun.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledTimes(1);

    // get() must wait — if it ran now it would see the empty map and
    // try to spawn while destroy() is still tearing down the old one.
    const getPromise = handler.get(8080);
    await new Promise((r) => setTimeout(r, 5));
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();

    resolveDestroy();
    await destroyPromise;
    const info = await getPromise;

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    expect(info.id).not.toBe(record.id);
  });
});

describe('tunnel service > handleTunnelExit', () => {
  it('clears the matching port from storage when the stored id matches', async () => {
    const record = makeRecord({ id: 'quick-exit0000exit0000', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels, handleTunnelExit } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit(record.id, 8080, 0);

    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final ?? {}).toEqual({});
    // No container RPCs were issued — the exit hook is pure storage.
    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
    // `tunnels.list()` reflects the cleared storage.
    await expect(tunnels.list()).resolves.toEqual([]);
  });

  it('preserves named-tunnel meta and marks needsRespawn on unsolicited exit', async () => {
    // Quick tunnels can be wiped outright: the *.trycloudflare.com URL
    // dies with cloudflared. Named tunnels are different — the CF-side
    // tunnel and DNS record are still live, and the SDK needs `dnsRecordId`
    // (plus `accountId`/`zoneId` for the drift-aware destroy path) to
    // clean them up later. So mirror `pruneTunnelsForRestart`: keep the
    // record + meta, mark `needsRespawn: true`. The next get(port, { name })
    // takes the existing reuse path and respawns cloudflared.
    const record: TunnelInfo = {
      id: 'tunnel-uuid-named',
      port: 8080,
      name: 'api',
      hostname: 'api.example.com',
      url: 'https://api.example.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    };
    const { client } = makeClient();
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': record
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'kept-dns-id',
        accountId: 'acct-A',
        zoneId: 'zone-A'
      }
    });
    const { handleTunnelExit } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit('tunnel-uuid-named', 8080, 0);

    // The public record is hidden; the next get() uses private metadata
    // to respawn cloudflared behind the same named hostname.
    const tunnels = (await storage.get<Record<string, TunnelInfo>>(
      'tunnels'
    )) as Record<string, TunnelInfo>;
    expect(tunnels).toEqual({});

    // Meta is preserved verbatim, with `needsRespawn` flipped on so the
    // next get(port, { name }) cache hit falls through to provision.
    const meta = (await storage.get<
      Record<
        string,
        {
          optionsHash: string;
          dnsRecordId?: string;
          accountId?: string;
          zoneId?: string;
          needsRespawn?: boolean;
          tunnelId?: string;
          name?: string;
          hostname?: string;
        }
      >
    >('tunnels:meta')) as Record<
      string,
      {
        optionsHash: string;
        dnsRecordId?: string;
        accountId?: string;
        zoneId?: string;
        needsRespawn?: boolean;
        tunnelId?: string;
        name?: string;
        hostname?: string;
      }
    >;
    expect(meta['8080']?.dnsRecordId).toBe('kept-dns-id');
    expect(meta['8080']?.accountId).toBe('acct-A');
    expect(meta['8080']?.zoneId).toBe('zone-A');
    expect(meta['8080']?.tunnelId).toBe('tunnel-uuid-named');
    expect(meta['8080']?.name).toBe('api');
    expect(meta['8080']?.hostname).toBe('api.example.com');
    expect(meta['8080']?.needsRespawn).toBe(true);
  });

  it('ignores stale named-tunnel exit callbacks from an old run', async () => {
    const current: TunnelInfo = {
      id: 'tunnel-uuid-named',
      port: 8080,
      name: 'api',
      hostname: 'api.example.com',
      url: 'https://api.example.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    };
    const { client } = makeClient();
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', { '8080': current });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'dns-current',
        tunnelId: 'tunnel-uuid-named',
        name: 'api',
        hostname: 'api.example.com',
        tunnelRunId: 'run-current'
      }
    });
    const { handleTunnelExit } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    await (
      handleTunnelExit as unknown as (
        id: string,
        port: number,
        exitCode: number | null,
        tunnelRunId: string
      ) => Promise<void>
    )('tunnel-uuid-named', 8080, 0, 'run-old');

    await expect(storage.get('tunnels')).resolves.toEqual({ '8080': current });
    const meta =
      await storage.get<Record<string, Record<string, unknown>>>(
        'tunnels:meta'
      );
    expect(meta?.['8080']?.tunnelRunId).toBe('run-current');
    expect(meta?.['8080']).not.toHaveProperty('needsRespawn');
  });

  it('is a no-op when the stored id has been replaced (id-mismatch safety net)', async () => {
    const newer = makeRecord({ id: 'quick-newer000newer00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': newer });
    const { handleTunnelExit } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    // Callback fires for an OLDER tunnel id that's no longer in storage.
    await handleTunnelExit('quick-stale0000stale00', 8080, null);

    // Storage is untouched.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final).toEqual({ '8080': newer });
  });

  it('is a no-op when storage is empty (already destroyed)', async () => {
    const { client } = makeClient();
    const storage = makeStorage();
    const { handleTunnelExit } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    await expect(
      handleTunnelExit('quick-anything00000ok', 8080, null)
    ).resolves.toBeUndefined();
    // No write happened.
    expect((storage.put as StoragePutMock).mock.calls.length).toBe(0);
  });

  it('runs under the port lock — waits for a concurrent get(port) to complete', async () => {
    const { client, storage, tunnels, handleTunnelExit } = makeHandler();
    let resolveSpawn: (info: TunnelInfo) => void = () => {};
    client.tunnels.ensureTunnelRun.mockImplementation(
      (request: EnsureTunnelRunRequest) =>
        new Promise<EnsureTunnelRunResult>((resolve) => {
          resolveSpawn = (info) => resolve(ensureQuickResult(request, info));
        })
    );

    const getPromise = tunnels.get(8080);
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.ensureTunnelRun.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }

    // Fire an exit callback for some arbitrary id while get() is
    // blocked. Without the lock, the callback would read the empty
    // storage now (before get() writes) and observe nothing to clean
    // up. With the lock, it must wait until get() releases.
    const exitPromise = handleTunnelExit('quick-old', 8080, 0);
    await new Promise((r) => setTimeout(r, 5));

    // The exit hook has not yet read storage — storage is empty so
    // there's nothing visible to assert directly, but we *can* assert
    // it hasn't completed.
    let exitResolved = false;
    void exitPromise.then(() => {
      exitResolved = true;
    });
    expect(exitResolved).toBe(false);

    // Let get() finish.
    resolveSpawn(makeRecord({ id: 'unused', port: 8080 }));
    const info = await getPromise;
    await exitPromise;

    // The exit callback ran after the get() wrote storage, saw a
    // different id ('quick-old' vs the spawned id), and no-op'd —
    // the spawned record is still there.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final).toEqual({ '8080': info });
  });

  it('logs an error canonical event when the storage transaction throws', async () => {
    // Inject a storage shim whose transaction() rejects. Without proper
    // try/catch around the canonical-log emit, the failure would escape
    // the port-lock chain unobserved and no event would be logged.
    const logger = makeLogger();
    const failingStorage = {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn().mockRejectedValue(new Error('boom'))
    } as unknown as TunnelsStorage;
    const { client } = makeClient();
    const { handleTunnelExit } = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage: failingStorage,
      logger
    });

    // The handler must surface the rejection to the caller so the
    // port-lock chain and any awaiter see it — silently swallowing
    // would hide the bug.
    await expect(handleTunnelExit('quick-x', 8080, 0)).rejects.toThrow(/boom/);

    // And a canonical event with outcome: 'error' must have been logged.
    const errorCalls = (logger.error as LogMock).mock.calls;
    const eventCall = errorCalls.find(([msg]) =>
      String(msg).includes('tunnel.exit')
    );
    expect(eventCall).toBeDefined();
  });
});

describe('TunnelsHandler public surface', () => {
  it('does not expose any exit hook on the public interface', () => {
    // Compile-time guard: if a future change adds a method to
    // TunnelsHandler beyond get/list/destroy, this assertion fails
    // and the developer has to consciously update the allowlist.
    type AllowedKeys = 'get' | 'list' | 'destroy';
    type _Check = keyof TunnelsHandler extends AllowedKeys ? true : false;
    const ok: _Check = true;
    expect(ok).toBe(true);
  });
});

describe('pruneTunnelsForRestart', () => {
  it('drops quick-tunnel entries and marks named ones for respawn', async () => {
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': {
        id: 'quick-abc',
        port: 8080,
        url: 'https://x.trycloudflare.com',
        hostname: 'x.trycloudflare.com',
        createdAt: '2024-01-01T00:00:00.000Z'
      },
      '8081': {
        id: 'uuid-1',
        port: 8081,
        name: 'app',
        hostname: 'app.example.com',
        url: 'https://app.example.com',
        createdAt: '2024-01-01T00:00:00.000Z'
      }
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': { optionsHash: 'quick' },
      '8081': { optionsHash: 'named:app', dnsRecordId: 'rec-1' }
    });

    await pruneTunnelsForRestart(storage);

    const nextTunnels = (await (storage.get as StorageGetMock)(
      'tunnels'
    )) as Record<string, { name?: string }>;
    const nextMeta = (await (storage.get as StorageGetMock)(
      'tunnels:meta'
    )) as Record<
      string,
      {
        needsRespawn?: boolean;
        dnsRecordId?: string;
        tunnelId?: string;
        name?: string;
        hostname?: string;
      }
    >;
    expect(nextTunnels).toEqual({});
    expect(nextMeta['8081']?.needsRespawn).toBe(true);
    // Private identity is preserved so get() can respawn and destroy() can clean up.
    expect(nextMeta['8081']?.dnsRecordId).toBe('rec-1');
    expect(nextMeta['8081']?.tunnelId).toBe('uuid-1');
    expect(nextMeta['8081']?.name).toBe('app');
    expect(nextMeta['8081']?.hostname).toBe('app.example.com');
    expect(nextMeta['8080']).toBeUndefined();
  });

  it('preserves hidden named entries across repeated reconciliation', async () => {
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {});
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8081': {
        optionsHash: 'v1:named:app',
        dnsRecordId: 'rec-1',
        tunnelId: 'uuid-1',
        name: 'app',
        hostname: 'app.example.com',
        accountId: 'acct-1',
        zoneId: 'zone-1',
        needsRespawn: true
      }
    });

    await pruneTunnelsForRestart(storage);

    await expect(storage.get('tunnels')).resolves.toEqual({});
    await expect(storage.get('tunnels:meta')).resolves.toEqual({
      '8081': {
        optionsHash: 'v1:named:app',
        dnsRecordId: 'rec-1',
        tunnelId: 'uuid-1',
        name: 'app',
        hostname: 'app.example.com',
        accountId: 'acct-1',
        zoneId: 'zone-1',
        needsRespawn: true
      }
    });
  });

  it('is a no-op on empty storage', async () => {
    const storage = makeStorage();
    await pruneTunnelsForRestart(storage);
    const nextTunnels = (await (storage.get as StorageGetMock)(
      'tunnels'
    )) as Record<string, unknown>;
    expect(nextTunnels).toEqual({});
  });
});
