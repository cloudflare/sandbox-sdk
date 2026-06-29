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
    expect(request.tunnelId).toMatch(/^quick-[0-9a-hjkmnp-tv-z]{20}$/);
    expect(request.runId).toMatch(/^run-[0-9a-hjkmnp-tv-z]{20}$/);
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

  it('mints short base32 quick tunnel ids', async () => {
    const { client, handler } = makeHandler();
    mockEnsureQuick(client.tunnels, async (id, port) =>
      makeRecord({ id, port })
    );

    const info = await handler.get(8080);
    const [{ tunnelId }] = client.tunnels.ensureTunnelRun.mock.calls[0];

    expect(tunnelId).toMatch(/^quick-[0-9a-hjkmnp-tv-z]{20}$/);
    expect(info.id).toBe(tunnelId);
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
    const firstRequest = client.tunnels.ensureTunnelRun.mock.calls[0][0];
    const secondRequest = client.tunnels.ensureTunnelRun.mock.calls[1][0];
    expect(secondRequest).toEqual(firstRequest);
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
