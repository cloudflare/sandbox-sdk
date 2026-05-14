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

export function createTunnelsHandler(host: TunnelsHandlerHost): TunnelsHandler {
  // Per-port inflight coalescing. Two simultaneous get(8080) calls on a
  // cold cache would otherwise mint two ids and spawn two cloudflared
  // processes. The slot is cleared in a `finally` so a failed spawn
  // doesn't poison subsequent calls for the same port.
  const inflight = new Map<number, Promise<TunnelInfo>>();

  async function readMap(): Promise<TunnelMap> {
    return (await host.storage.get<TunnelMap>(STORAGE_KEY)) ?? {};
  }

  async function get(port: number): Promise<TunnelInfo> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let cacheState: 'hit' | 'miss' = 'miss';
    let caughtError: Error | undefined;
    try {
      validateTunnelPort(port);

      // Coalescing has to start synchronously: two concurrent get()
      // calls both need to observe each other's inflight slot before
      // doing the storage read, otherwise they each mint an id and
      // spawn a duplicate cloudflared process.
      const inflightExisting = inflight.get(port);
      if (inflightExisting) {
        const info = await inflightExisting;
        outcome = 'success';
        return info;
      }

      const work = (async (): Promise<TunnelInfo> => {
        const map = await readMap();
        const existing = map[port.toString()];
        if (existing) {
          cacheState = 'hit';
          return existing;
        }
        const id = `quick-${shortId()}`;
        const info = await host.client.tunnels.runQuickTunnel(id, port);
        // Atomic re-read and write. The cloudflared await above yields,
        // so a concurrent get(otherPort) may have written between our
        // first readMap() and now; transaction() retries on conflict.
        await host.storage.transaction(async (txn) => {
          const nextMap = (await txn.get<TunnelMap>(STORAGE_KEY)) ?? {};
          nextMap[port.toString()] = info;
          await txn.put(STORAGE_KEY, nextMap);
        });
        return info;
      })();
      inflight.set(port, work);
      try {
        const info = await work;
        outcome = 'success';
        return info;
      } finally {
        // Always clear the slot — including on failure — so the next
        // caller retries instead of awaiting a rejected promise.
        if (inflight.get(port) === work) inflight.delete(port);
      }
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
      const map = await readMap();
      const existing = map[port.toString()];
      if (!existing) {
        // Idempotent — destroying an unknown port resolves successfully.
        outcome = 'success';
        return;
      }
      tunnelId = existing.id;

      // Atomic clear: same race window as get(), since destroyTunnel()
      // also yields. Wrap the read-modify-write so a concurrent
      // get(otherPort) write doesn't resurrect this entry. Storage is
      // cleared *before* the container RPC for the same reason as
      // portTokens (sandbox.ts:1795): a get(port) that races our destroy
      // should see a cache miss and spawn fresh rather than reuse the
      // record we're tearing down.
      await host.storage.transaction(async (txn) => {
        const current = (await txn.get<TunnelMap>(STORAGE_KEY)) ?? {};
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

  return { get, list, destroy };
}
