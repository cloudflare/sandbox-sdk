import type { Logger } from '@repo/shared';
import { vi } from 'vitest';
import type {
  TunnelServiceHost,
  TunnelsStorage
} from '../../src/tunnels/rpc-target';

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
): Pick<TunnelServiceHost, 'currentRuntime' | 'currentLifetime'> {
  return {
    currentRuntime: {
      get: vi.fn(async () => ({ id: 'runtime-1' })),
      markStarted: vi.fn(async () => ({ id: 'runtime-1' })),
      assertActive: vi.fn(async () => {}),
      ...overrides.currentRuntime
    },
    currentLifetime: {
      getOrCreate: vi.fn(async () => ({ id: 'lifetime-1' })),
      assertCurrent: vi.fn(async () => {}),
      ...overrides.currentLifetime
    }
  } as unknown as Pick<TunnelServiceHost, 'currentRuntime' | 'currentLifetime'>;
}
