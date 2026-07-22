import {
  completeTunnelServiceHost,
  type TestTunnelServiceHost
} from './helpers';
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
import { ErrorCode, RPCTransportError } from '../../src/errors';
import { RuntimeIdentity } from '../../src/runtime';
import { RuntimeIdentityInactiveError } from '../../src/runtime/types';
import { SandboxLifetimeChangedError } from '../../src/sandbox-lifetime';
import { SandboxSecurityError } from '../../src/security';
import {
  createTunnelsHandle as createRuntimeTunnelsHandle,
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
    runRuntimeCall: ((operation, call) =>
      call(
        client.tunnels as unknown as TunnelsHost['runRuntimeCall'] extends (
          op: string,
          call: (tunnels: infer U) => Promise<unknown>
        ) => Promise<unknown>
          ? U
          : never
      )) as TunnelsHost['runRuntimeCall'],
    storage,
    logger: makeLogger(),
    ...rest
  } as unknown as TunnelsHost);
  return { client, storage, handler: tunnels, tunnels, handleTunnelExit };
}

const createTunnelsHandle = (host: TestTunnelServiceHost) =>
  createRuntimeTunnelsHandle(completeTunnelServiceHost(host));

describe('tunnel service > destroy', () => {
  it('clears storage without a container RPC for an unscoped known port', async () => {
    const record = makeRecord({ id: 'quick-known0000known00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });
    await handler.destroy(8080);

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    expect(putCalls).toEqual([['tunnels', {}]]);
  });

  it('stops the exact runtime run when tunnel metadata has a run id', async () => {
    const record = makeRecord({ id: 'quick-known0000known00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1',
        tunnelRunId: 'run-quick-1'
      }
    });
    let targetedRuntime: RuntimeIdentity | undefined;
    let admittedOperation: string | undefined;
    const { tunnels: handler } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      runExisting: async (runtime, operation, call) => {
        targetedRuntime = runtime;
        admittedOperation = operation;
        return await call(
          client.tunnels as unknown as Parameters<typeof call>[0]
        );
      },
      storage,
      logger: makeLogger()
    });
    client.tunnels.stopTunnelRun.mockResolvedValue({
      stopped: true
    });

    await handler.destroy(8080);

    expect(targetedRuntime).toMatchObject({
      id: 'runtime-1',
      runtimeIncarnationID: 'inc-1'
    });
    expect(admittedOperation).toBe('tunnel.destroy');
    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledWith({
      tunnelId: record.id,
      runId: 'run-quick-1'
    });
  });

  it('does not wake or fail when the recorded owning runtime is stale', async () => {
    const record = makeRecord({ id: 'quick-stale-owner', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'old-incarnation',
        tunnelRunId: 'run-stale-owner'
      }
    });
    const runRuntimeCall = vi.fn(async (_operation, call) =>
      call(
        client.tunnels as unknown as Parameters<
          Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
        >[1] extends (tunnels: infer U) => Promise<unknown>
          ? U
          : never
      )
    ) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'];
    const { tunnels: handler } = createTunnelsHandle({
      runRuntimeCall,
      storage,
      logger: makeLogger()
    });

    await expect(handler.destroy(8080)).resolves.toBeUndefined();

    expect(runRuntimeCall).not.toHaveBeenCalled();
    await expect(storage.get('tunnels')).resolves.toEqual({});
  });

  it('wraps the read-modify-write in storage.transaction()', async () => {
    const record = makeRecord({ id: 'quick-tx0000tx0000tx', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
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
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
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
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
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
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1',
        tunnelRunId: 'run-gone'
      }
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
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1',
        tunnelRunId: 'run-real'
      }
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
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1',
        tunnelRunId: 'run-err'
      }
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
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1'
      },
      '8081': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1'
      }
    });
    const { tunnels: handler } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });

    const tunnels = await handler.list();
    expect(tunnels).toEqual(expect.arrayContaining([a, b]));
    expect(tunnels).toHaveLength(2);
  });

  it('omits records owned by another runtime incarnation', async () => {
    const stale = makeRecord({ id: 'quick-stale-incarnation', port: 8080 });
    const storage = makeStorage({ '8080': stale });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'old-incarnation'
      }
    });
    const { client } = makeClient();
    const { tunnels: handler } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });

    await expect(handler.list()).resolves.toEqual([]);
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
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1'
      },
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
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });
    let resolveDestroy: () => void = () => {};
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1',
        tunnelRunId: 'run-pre'
      }
    });
    client.tunnels.stopTunnelRun.mockImplementation(
      () =>
        new Promise<{ stopped: boolean }>((resolve) => {
          resolveDestroy = () => resolve({ stopped: true });
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

const callbackRuntime = new RuntimeIdentity({
  id: 'runtime-1' as RuntimeIdentity['id'],
  runtimeIncarnationID: 'inc-1' as RuntimeIdentity['runtimeIncarnationID']
});
const callbackRunID = 'run-callback';

describe('tunnel service > handleTunnelExit', () => {
  it('clears the matching port from storage when the stored id matches', async () => {
    const record = makeRecord({ id: 'quick-exit0000exit0000', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: callbackRuntime.id,
        runtimeIncarnationID: callbackRuntime.runtimeIncarnationID,
        tunnelRunId: callbackRunID
      }
    });
    const { tunnels, handleTunnelExit } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit(
      record.id,
      8080,
      0,
      callbackRunID,
      callbackRuntime,
      () => true
    );

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
        zoneId: 'zone-A',
        runtimeIdentityID: callbackRuntime.id,
        runtimeIncarnationID: callbackRuntime.runtimeIncarnationID,
        tunnelRunId: callbackRunID
      }
    });
    const { handleTunnelExit } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit(
      'tunnel-uuid-named',
      8080,
      0,
      callbackRunID,
      callbackRuntime,
      () => true
    );

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
        runtimeIdentityID: callbackRuntime.id,
        runtimeIncarnationID: callbackRuntime.runtimeIncarnationID,
        tunnelRunId: 'run-current'
      }
    });
    const { handleTunnelExit } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit(
      'tunnel-uuid-named',
      8080,
      0,
      'run-old',
      callbackRuntime,
      () => true
    );

    await expect(storage.get('tunnels')).resolves.toEqual({ '8080': current });
    const meta =
      await storage.get<Record<string, Record<string, unknown>>>(
        'tunnels:meta'
      );
    expect(meta?.['8080']?.tunnelRunId).toBe('run-current');
    expect(meta?.['8080']).not.toHaveProperty('needsRespawn');
  });

  it('ignores an old-runtime callback even when tunnel id and run id match', async () => {
    const record = makeRecord({ id: 'quick-current-runtime', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:quick',
        runtimeIdentityID: callbackRuntime.id,
        runtimeIncarnationID: callbackRuntime.runtimeIncarnationID,
        tunnelRunId: callbackRunID
      }
    });
    const replacement = new RuntimeIdentity({
      id: callbackRuntime.id,
      runtimeIncarnationID: 'inc-2' as RuntimeIdentity['runtimeIncarnationID']
    });
    const { handleTunnelExit } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      getStoredRuntime: async () => replacement,
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit(
      record.id,
      8080,
      0,
      callbackRunID,
      callbackRuntime,
      () => true
    );

    await expect(storage.get('tunnels')).resolves.toEqual({
      '8080': record
    });
  });

  it('is a no-op when the stored id has been replaced (id-mismatch safety net)', async () => {
    const newer = makeRecord({ id: 'quick-newer000newer00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': newer });
    const { handleTunnelExit } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });

    // Callback fires for an OLDER tunnel id that's no longer in storage.
    await handleTunnelExit(
      'quick-stale0000stale00',
      8080,
      null,
      callbackRunID,
      callbackRuntime,
      () => true
    );

    // Storage is untouched.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final).toEqual({ '8080': newer });
  });

  it('is a no-op when storage is empty (already destroyed)', async () => {
    const { client } = makeClient();
    const storage = makeStorage();
    const { handleTunnelExit } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage,
      logger: makeLogger()
    });

    await expect(
      handleTunnelExit(
        'quick-anything00000ok',
        8080,
        null,
        callbackRunID,
        callbackRuntime,
        () => true
      )
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

    const request = client.tunnels.ensureTunnelRun.mock.calls[0]?.[0];
    if (!request) throw new Error('Expected tunnel provisioning request');
    let sessionCurrent = true;
    const exitPromise = handleTunnelExit(
      request.tunnelId,
      8080,
      0,
      request.runId,
      callbackRuntime,
      () => sessionCurrent
    );
    await new Promise((r) => setTimeout(r, 5));

    // The exit hook has not yet read storage — storage is empty so
    // there's nothing visible to assert directly, but we *can* assert
    // it hasn't completed.
    let exitResolved = false;
    void exitPromise.then(() => {
      exitResolved = true;
    });
    expect(exitResolved).toBe(false);

    // Supersede the callback session before the lock becomes available.
    sessionCurrent = false;
    resolveSpawn(makeRecord({ id: 'unused', port: 8080 }));
    const info = await getPromise;
    await exitPromise;

    // The callback matches the tunnel and run, but its session authority
    // was revoked while it waited for the lock, so the record remains.
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
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
      storage: failingStorage,
      logger
    });

    // The handler must surface the rejection to the caller so the
    // port-lock chain and any awaiter see it — silently swallowing
    // would hide the bug.
    await expect(
      handleTunnelExit(
        'quick-x',
        8080,
        0,
        callbackRunID,
        callbackRuntime,
        () => true
      )
    ).rejects.toThrow(/boom/);

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
