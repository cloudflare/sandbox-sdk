import type { Logger, SandboxTunnelsAPI } from '@repo/shared';
import { vi } from 'vitest';
import { RuntimeIdentity } from '../../src/runtime';
import type {
  TunnelServiceHost,
  TunnelsStorage
} from '../../src/tunnels/rpc-target';

type TunnelRuntimeCall = <T>(
  operation: string,
  call: (tunnels: SandboxTunnelsAPI) => Promise<T>
) => Promise<T>;

export type TestTunnelServiceHost = Omit<
  TunnelServiceHost,
  'runProvision' | 'runExisting' | 'getStoredRuntime'
> &
  Partial<
    Pick<TunnelServiceHost, 'runProvision' | 'runExisting' | 'getStoredRuntime'>
  > & { runRuntimeCall: TunnelRuntimeCall };

export function completeTunnelServiceHost(
  host: TestTunnelServiceHost
): TunnelServiceHost {
  const runtime = new RuntimeIdentity({
    id: 'runtime-1' as RuntimeIdentity['id'],
    runtimeIncarnationID: 'inc-1' as RuntimeIdentity['runtimeIncarnationID']
  });
  const { runRuntimeCall, ...serviceHost } = host;
  return {
    ...serviceHost,
    getStoredRuntime: host.getStoredRuntime ?? (async () => runtime),
    runProvision:
      host.runProvision ??
      ((call) =>
        runRuntimeCall('tunnel.provision', (tunnels) =>
          call({
            runtime,
            tunnels,
            retain: () => ({ release: () => {} })
          })
        )),
    runExisting:
      host.runExisting ??
      ((target, operation, call) => {
        if (
          target.id !== runtime.id ||
          target.runtimeIncarnationID !== runtime.runtimeIncarnationID
        ) {
          return Promise.resolve(null);
        }
        return runRuntimeCall(operation, call);
      })
  };
}

export function makeLogger(): Logger {
  const log: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => log)
  } as unknown as Logger;
  return log;
}

export function makeStorage(
  seed: Record<string, unknown> = {}
): TunnelsStorage {
  const data = new Map<string, unknown>(Object.entries(seed));
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

export function makeFences(
  overrides: {
    currentRuntime?: Record<string, unknown>;
    currentLifetime?: Record<string, unknown>;
  } = {}
): Pick<TunnelServiceHost, 'getStoredRuntime' | 'currentLifetime'> {
  const runtime = {
    id: 'runtime-1',
    runtimeIncarnationID: 'inc-1'
  };
  const getRuntime = overrides.currentRuntime?.get as
    | (() => Promise<unknown>)
    | undefined;
  return {
    getStoredRuntime: async () => {
      const value = getRuntime ? await getRuntime() : runtime;
      if (!value) return null;
      const record = value as { id: string; runtimeIncarnationID?: string };
      return {
        id: record.id,
        runtimeIncarnationID: record.runtimeIncarnationID ?? 'inc-1'
      } as Awaited<ReturnType<TunnelServiceHost['getStoredRuntime']>>;
    },
    currentLifetime: {
      getOrCreate: vi.fn(async () => ({ id: 'lifetime-1' })),
      assertCurrent: vi.fn(async () => {}),
      ...overrides.currentLifetime
    }
  } as unknown as Pick<
    TunnelServiceHost,
    'getStoredRuntime' | 'currentLifetime'
  >;
}
