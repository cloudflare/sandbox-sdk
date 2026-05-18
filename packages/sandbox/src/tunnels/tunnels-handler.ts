/**
 * Tunnels namespace handler. Created once per Sandbox DO instance via
 * `createTunnelsHandler(host)` and exposed as `sandbox.tunnels`.
 *
 * Storage is the source of truth. The DO holds a `Record<portString, TunnelInfo>`
 * under the `tunnels` storage key. `Sandbox.onStart()` clears the key on every
 * container restart so any record in storage is by construction backed by a
 * running `cloudflared` process; the handler never needs to verify that
 * separately against the container.
 */

import type { Logger, SandboxTunnelsAPI, TunnelInfo } from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import { SandboxSecurityError, validatePort } from '../security';

/** Subset of the RPC client this handler depends on. */
interface TunnelsRPCClient {
  tunnels: SandboxTunnelsAPI;
}

/**
 * Subset of `DurableObjectTransaction` (and `DurableObjectStorage`) used
 * inside a transaction closure — no nested `transaction()`.
 */
export interface TunnelsStorageTxn {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/**
 * Subset of `DurableObjectStorage` the handler uses.
 *
 * `transaction` gives optimistic concurrency for the read-modify-write
 * paths in `get()` and `destroy()`: while we await the container RPC,
 * another request to the same DO can land and rewrite the `tunnels`
 * key. Wrapping the write in `transaction()` makes the runtime retry
 * on conflict instead of clobbering the concurrent write.
 */
export interface TunnelsStorage extends TunnelsStorageTxn {
  transaction<T>(closure: (txn: TunnelsStorageTxn) => Promise<T>): Promise<T>;
}

/** Subset of the Sandbox DO the handler reads from. */
export interface TunnelsHandlerHost {
  client: TunnelsRPCClient;
  storage: TunnelsStorage;
  logger: Logger;
}

export interface TunnelsHandler {
  get(port: number): Promise<TunnelInfo>;
  list(): Promise<TunnelInfo[]>;
  destroy(portOrInfo: number | TunnelInfo): Promise<void>;
}

/**
 * Container-driven exit hook. Invoked by `SandboxControlCallbackImpl`
 * when the container reports that a `cloudflared` process has
 * exited. NOT part of the public `TunnelsHandler` interface —
 * exposed only through the factory's return shape so the public
 * `sandbox.tunnels` API stays narrow.
 */
export type TunnelExitHandler = (
  id: string,
  port: number,
  exitCode: number | null
) => Promise<void>;

export interface TunnelsHandle {
  tunnels: TunnelsHandler;
  handleTunnelExit: TunnelExitHandler;
}

/** DO storage key for the `port → TunnelInfo` map. */
const STORAGE_KEY = 'tunnels';

type TunnelMap = Record<string, TunnelInfo>;

function validateTunnelPort(port: number): void {
  if (!validatePort(port)) {
    throw new SandboxSecurityError(
      `Invalid port number: ${port}. Must be 1024-65535, excluding reserved ports.`
    );
  }
}

/** 8-char hex id derived from `crypto.getRandomValues`. Unique per sandbox. */
function shortId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isTunnelNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('TUNNEL_NOT_FOUND');
}

export function createTunnelsHandler(host: TunnelsHandlerHost): TunnelsHandle {
  // Per-port serialization lock. Any operation that mutates the tunnel
  // for a given port — get() on a cache miss, destroy() — queues behind
  // the previous operation on the same port. Two consequences:
  //
  //   - get(8080) followed by destroy(8080) is well-ordered: the destroy
  //     observes whatever the get just wrote, even though both yield to
  //     external RPCs in the middle.
  //   - Two concurrent get(8080) calls share the first call's record:
  //     the second runs after the first writes storage and takes the
  //     hit branch (so no double cloudflared spawn).
  //
  // The lock is a plain Promise chain keyed by port. `transaction()` on
  // the storage write still matters for *cross-port* writes — a
  // get(8080) and get(8081) running in parallel are independent here.
  const portLocks = new Map<number, Promise<unknown>>();

  function withPortLock<T>(port: number, fn: () => Promise<T>): Promise<T> {
    const previous = portLocks.get(port) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Swallow rejections on the chain so a failed op doesn't poison
    // subsequent ones; the original promise still rejects to the caller.
    portLocks.set(
      port,
      next.catch(() => undefined)
    );
    return next;
  }

  async function readMap(
    storage: TunnelsStorageTxn = host.storage
  ): Promise<TunnelMap> {
    return (await storage.get<TunnelMap>(STORAGE_KEY)) ?? {};
  }

  async function get(port: number): Promise<TunnelInfo> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let cacheState: 'hit' | 'miss' = 'miss';
    let caughtError: Error | undefined;
    try {
      validateTunnelPort(port);

      const info = await withPortLock(port, async () => {
        const map = await readMap();
        const existing = map[port.toString()];
        if (existing) {
          cacheState = 'hit';
          return existing;
        }
        const id = `quick-${shortId()}`;
        const spawned = await host.client.tunnels.runQuickTunnel(id, port);
        // Atomic re-read + write. The lock orders same-port ops, but
        // a concurrent get(otherPort) can still write the `tunnels` key
        // between the cloudflared await above and here. transaction()
        // retries on conflict so the cross-port write doesn't clobber.
        await host.storage.transaction(async (txn) => {
          const nextMap = await readMap(txn);
          nextMap[port.toString()] = spawned;
          await txn.put(STORAGE_KEY, nextMap);
        });
        return spawned;
      });
      outcome = 'success';
      return info;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(host.logger, {
        event: 'tunnel.get',
        outcome,
        port,
        cacheState,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  async function destroy(portOrInfo: number | TunnelInfo): Promise<void> {
    const port = typeof portOrInfo === 'number' ? portOrInfo : portOrInfo.port;
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let tunnelId: string | undefined;
    try {
      await withPortLock(port, async () => {
        const map = await readMap();
        const existing = map[port.toString()];
        if (!existing) {
          // Idempotent — destroying an unknown port resolves successfully.
          return;
        }
        tunnelId = existing.id;

        // Clear storage first. Same ordering as portTokens (sandbox.ts):
        // a hypothetical reader that observes storage between the put
        // below and the destroyTunnel RPC sees a cache miss — the right
        // answer, since the tunnel is on its way out. The port lock
        // means no in-process get(port) is racing with us, but Workers
        // / external readers don't go through this handler.
        await host.storage.transaction(async (txn) => {
          const current = await readMap(txn);
          delete current[port.toString()];
          await txn.put(STORAGE_KEY, current);
        });

        try {
          await host.client.tunnels.destroyTunnel(existing.id);
        } catch (error) {
          if (!isTunnelNotFoundError(error)) throw error;
          // Container already forgot — treat as success. Storage is
          // already cleared above, so we're done.
        }
      });
      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(host.logger, {
        event: 'tunnel.destroy',
        outcome,
        port,
        tunnelId,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  async function list(): Promise<TunnelInfo[]> {
    const map = await readMap();
    return Object.values(map);
  }

  const handleTunnelExit: TunnelExitHandler = async (id, port, exitCode) => {
    const startTime = Date.now();
    await withPortLock(port, async () => {
      await host.storage.transaction(async (txn) => {
        const map = await readMap(txn);
        const existing = map[port.toString()];
        // Defensive: only clear if storage still references this exact
        // tunnel id. Without this check, a sequence like "old
        // cloudflared dies → new get() spawns fresh → old callback
        // fires" would clobber the new record.
        if (existing?.id === id) {
          delete map[port.toString()];
          await txn.put(STORAGE_KEY, map);
        }
      });
      logCanonicalEvent(host.logger, {
        event: 'tunnel.exit',
        outcome: 'success',
        port,
        tunnelId: id,
        exitCode: exitCode ?? undefined,
        durationMs: Date.now() - startTime
      });
    });
  };

  return {
    tunnels: { get, list, destroy },
    handleTunnelExit
  };
}
