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

import { RpcTarget } from 'cloudflare:workers';
import type {
  Logger,
  NamedTunnelInfo,
  QuickTunnelInfo,
  SandboxTunnelsAPI,
  TunnelInfo,
  TunnelOptions
} from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import type { CurrentRuntimeIdentity } from '../current-runtime-identity';
import type { CurrentSandboxLifetime } from '../sandbox-lifetime';
import {
  SandboxSecurityError,
  validatePort,
  validateTunnelName
} from '../security';
import {
  cleanupNamedTunnelResources,
  resumeNamedTunnelCleanupEntry,
  resumeNamedTunnelCleanupRecords
} from './cleanup';
import {
  createTunnel,
  findTunnelByName,
  getTunnelToken,
  getZoneName,
  upsertCNAME
} from './cloudflare-api';
import { TunnelOperationLifecycle } from './lifecycle';
import type { TunnelsStorage } from './storage';
import {
  CLEANUP_STORAGE_KEY,
  computeOptionsHash,
  createNamedTunnelCleanupEntry,
  effectiveOptionsHash,
  META_STORAGE_KEY,
  markNamedTunnelNeedsRespawn,
  namedTunnelInfoFromMeta,
  optionsHashesEqual,
  readCleanupMap,
  readMap,
  readMetaMap,
  STORAGE_KEY,
  tunnelConfigChanged
} from './storage';

export { pruneTunnelsForRestart } from './restart';
export type { TunnelsStorage, TunnelsStorageTxn } from './storage';

/** Subset of the RPC client this handler depends on. */
interface TunnelsRPCClient {
  tunnels: SandboxTunnelsAPI;
}

/** Subset of the Sandbox DO the handler reads from. */
export interface TunnelsHandlerHost {
  client: TunnelsRPCClient;
  storage: TunnelsStorage;
  logger: Logger;
  /**
   * Sandbox identifier used for tagging Cloudflare resources
   * (`metadata.sandboxId` on tunnels, `comment: 'sandbox-<id>'` on DNS).
   * Required only when callers exercise `get(port, { name })`; quick
   * tunnels do not touch the Cloudflare API.
   */
  sandboxId?: string;
  /**
   * Lazy provider of the three credentials needed for named-tunnel
   * provisioning. Called at most once per `get(port, { name })` invocation;
   * the handler does not memoise the result across calls so a Worker
   * binding change is observable without a redeploy.
   *
   * Throws (via the underlying resolver) when any required value is
   * missing or unresolvable. The handler surfaces that error verbatim.
   */
  getNamedTunnelConfig?: () => Promise<{
    token: string;
    accountId: string;
    zoneId: string;
  }>;
  /**
   * Override the global `fetch` used for Cloudflare API calls. Defaults
   * to the global `fetch`. Tests inject a mock here.
   */
  fetcher?: typeof fetch;
  /** Runtime fence for records backed by a current container process. */
  currentRuntime?: Pick<
    CurrentRuntimeIdentity,
    'get' | 'markStarted' | 'assertActive'
  >;
  /** Sandbox lifetime fence for operations that must not cross destroy(). */
  currentLifetime?: Pick<
    CurrentSandboxLifetime,
    'getOrCreate' | 'assertCurrent'
  >;
}

export interface TunnelsHandler {
  get(port: number, options?: TunnelOptions): Promise<TunnelInfo>;
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
  /**
   * Tear down every tunnel currently stored. Called by the Sandbox DO's
   * `destroy()` so the Cloudflare-side resources don't outlive the
   * sandbox that provisioned them.
   *
   * Best-effort: a failure on one port is logged but doesn't abort the
   * rest. NOT part of the public `TunnelsHandler` surface — users don't
   * call this; they call `destroy(port)` for an individual tunnel.
   */
  destroyAll: () => Promise<void>;
  /** Resume retained Cloudflare-side cleanup records. Internal lifecycle hook. */
  resumeCleanup: () => Promise<void>;
}

/** Per-port serializer shared between `TunnelsRpcTarget` and the exit hook. */
type WithPortLock = <T>(port: number, fn: () => Promise<T>) => Promise<T>;

type TunnelGetCacheState = 'hit' | 'miss';

interface TunnelGetResult {
  info: TunnelInfo;
  cacheState: TunnelGetCacheState;
}

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

/**
 * Match a structured SandboxError code anywhere on the error — translated
 * SandboxErrors expose the code both as a top-level `code` field and on
 * the nested `errorResponse.code`. Used for the few error codes the SDK
 * recognises and recovers from (TUNNEL_NOT_FOUND, TUNNEL_ALREADY_RUNNING).
 *
 * Structured matching keeps quoted code tokens in human-readable
 * messages from being treated as machine-readable error codes.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    code?: unknown;
    errorResponse?: { code?: unknown };
  };
  if (e.code === code) return true;
  if (e.errorResponse?.code === code) return true;
  return false;
}

function isTunnelNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, 'TUNNEL_NOT_FOUND');
}

function isTunnelAlreadyRunningError(error: unknown): boolean {
  return hasErrorCode(error, 'TUNNEL_ALREADY_RUNNING');
}

/**
 * Concrete `TunnelsHandler` implementation.
 *
 * Extends `RpcTarget` for forward compatibility with direct Workers RPC
 * pipelining (`stub.tunnels.get(port)`): only `RpcTarget` instances may
 * be passed by reference across the Workers RPC boundary. Today the
 * public `sandbox.tunnels` proxy in `getSandbox()` dispatches through
 * `stub.callTunnels(method, args)` instead — pipelining through
 * property getters is broken under the vite-plugin runtime — so the
 * `RpcTarget` base is not on the hot call path. It is retained so the
 * pipelining shape works once that constraint lifts.
 */
class TunnelsRpcTarget extends RpcTarget implements TunnelsHandler {
  // ECMAScript private fields (not TS `private`) so they are not
  // observable as own properties on the RPC receiver and cannot be
  // invoked from a Worker.
  readonly #host: TunnelsHandlerHost;
  readonly #withPortLock: WithPortLock;
  readonly #lifecycle: TunnelOperationLifecycle;
  /**
   * Memoised zone name (e.g. `'example.com'`) for the configured
   * `CLOUDFLARE_ZONE_ID`. Filled in lazily on the first named-tunnel
   * `get()` so quick-tunnel callers never hit the zone-lookup endpoint.
   *
   * Only successful resolutions are cached: a rejected lookup clears
   * the slot so the next caller retries after a transient error.
   */
  #zoneNamePromise: Promise<string> | null = null;

  constructor(host: TunnelsHandlerHost, withPortLock: WithPortLock) {
    super();
    this.#host = host;
    this.#withPortLock = withPortLock;
    this.#lifecycle = new TunnelOperationLifecycle(host);
  }

  /**
   * Resolve the zone name for the configured zone id. Memoised for the
   * lifetime of this handler; the zone name doesn't change while a DO
   * is alive, and one extra GET on first use is cheaper than threading
   * the value through the host.
   *
   * On failure the cached promise is cleared so the next caller retries
   * the zone lookup with a fresh Cloudflare API request.
   */
  async #getZoneName(config: {
    token: string;
    zoneId: string;
  }): Promise<string> {
    if (!this.#zoneNamePromise) {
      const pending = getZoneName({
        token: config.token,
        zoneId: config.zoneId,
        fetcher: this.#host.fetcher
      });
      this.#zoneNamePromise = pending;
      // Side-effect handler: clear the cache if `pending` rejects so the
      // next caller retries. Callers `await this.#zoneNamePromise`
      // directly, so they still observe the rejection unchanged.
      pending.catch(() => {
        if (this.#zoneNamePromise === pending) {
          this.#zoneNamePromise = null;
        }
      });
    }
    return this.#zoneNamePromise;
  }

  async get(port: number, options?: TunnelOptions): Promise<TunnelInfo> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let cacheState: TunnelGetCacheState = 'miss';
    let caughtError: Error | undefined;
    try {
      validateTunnelPort(port);
      if (options?.name !== undefined) validateTunnelName(options.name);
      const requestedHash = computeOptionsHash(options);

      const result = await this.#lifecycle.runGetWithRecovery(() =>
        this.#withPortLock(port, () =>
          this.#getLocked(port, options, requestedHash)
        )
      );
      cacheState = result.cacheState;
      outcome = 'success';
      return result.info;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.#host.logger, {
        event: 'tunnel.get',
        outcome,
        port,
        cacheState,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  async #getLocked(
    port: number,
    options: TunnelOptions | undefined,
    requestedHash: string
  ): Promise<TunnelGetResult> {
    const portKey = port.toString();
    const map = await readMap(this.#host.storage);
    const meta = await readMetaMap(this.#host.storage);
    const existing = map[portKey];
    const metaEntry = meta[portKey];

    if (existing) {
      this.#assertSameOptions(
        port,
        effectiveOptionsHash(existing, metaEntry),
        requestedHash
      );

      if (metaEntry?.needsRespawn && existing.name) {
        return {
          info: await this.#provisionNamedTunnel(port, existing.name),
          cacheState: 'miss'
        };
      }

      if (existing.name && this.#host.getNamedTunnelConfig) {
        const currentConfig = await this.#host.getNamedTunnelConfig();
        if (tunnelConfigChanged(metaEntry, currentConfig)) {
          this.#zoneNamePromise = null;
          return {
            info: await this.#provisionNamedTunnel(port, existing.name),
            cacheState: 'miss'
          };
        }
      }

      if (metaEntry?.runtimeIdentityID) {
        const currentRuntime = await this.#host.currentRuntime?.get();
        if (currentRuntime?.id !== metaEntry.runtimeIdentityID) {
          return {
            info: existing.name
              ? await this.#provisionNamedTunnel(port, existing.name)
              : await this.#provisionQuickTunnel(port),
            cacheState: 'miss'
          };
        }
      }

      return { info: existing, cacheState: 'hit' };
    }

    if (metaEntry?.needsRespawn) {
      this.#assertSameOptions(port, metaEntry.optionsHash, requestedHash);
    }

    return {
      info: options?.name
        ? await this.#provisionNamedTunnel(port, options.name)
        : await this.#provisionQuickTunnel(port),
      cacheState: 'miss'
    };
  }

  #assertSameOptions(
    port: number,
    existingHash: string,
    requestedHash: string
  ): void {
    if (optionsHashesEqual(existingHash, requestedHash)) return;
    throw new Error(
      `Tunnel on port ${port} was created with different options. ` +
        `Call destroy(${port}) before changing tunnel options.`
    );
  }

  async #resumePortCleanup(port: number): Promise<void> {
    const portKey = port.toString();
    const cleanup = await readCleanupMap(this.#host.storage);
    const entry = cleanup[portKey];
    if (!entry) return;

    if (
      !(await resumeNamedTunnelCleanupEntry(
        this.#host,
        this.#host.storage,
        portKey,
        entry
      ))
    ) {
      throw new Error(
        `Pending named tunnel cleanup for port ${port} could not complete.`
      );
    }
  }

  /**
   * Provision a fresh quick tunnel and persist it. Caller holds the
   * per-port lock.
   *
   * Quick-tunnel ids are minted from a 32-bit random source. Collisions
   * are astronomically unlikely, but if the container happens to already
   * have one running under the freshly-minted id it rejects with
   * TUNNEL_ALREADY_RUNNING. The retry budget mints fresh ids while
   * still surfacing a persistent collision failure.
   */
  async #provisionQuickTunnel(port: number): Promise<QuickTunnelInfo> {
    const MAX_ID_RETRIES = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt += 1) {
      const id = `quick-${shortId()}`;
      try {
        const lifecycle = await this.#lifecycle.capture();
        const spawned = (await this.#host.client.tunnels.runQuickTunnel(
          id,
          port
        )) as QuickTunnelInfo;
        await this.#lifecycle.assertActive(lifecycle, 'process_ready', true);
        await this.#host.storage.transaction(async (txn) => {
          const nextMap = await readMap(txn);
          nextMap[port.toString()] = spawned;
          await txn.put(STORAGE_KEY, nextMap);
          const nextMeta = await readMetaMap(txn);
          nextMeta[port.toString()] = {
            optionsHash: 'v1:quick',
            ...(lifecycle.runtime && {
              runtimeIdentityID: lifecycle.runtime.id
            }),
            ...(lifecycle.lifetime && {
              sandboxLifetimeID: lifecycle.lifetime.id
            })
          };
          await txn.put(META_STORAGE_KEY, nextMeta);
        });
        await this.#lifecycle.assertActive(lifecycle, 'committing', true);
        return spawned;
      } catch (err) {
        if (!isTunnelAlreadyRunningError(err)) throw err;
        // Collision: try again with a fresh id.
        lastError = err;
      }
    }
    // Exhausted the retry budget. Surface the last collision error so the
    // caller sees something diagnosable; in practice this branch is
    // unreachable given the 32-bit id space and per-sandbox tunnel count.
    throw lastError ?? new Error('Failed to mint a unique quick-tunnel id');
  }

  /**
   * Provision a named tunnel end-to-end:
   *   1. resolve credentials + zone name
   *   2. reuse or create the Cloudflare tunnel resource
   *   3. upsert the proxied CNAME (or reuse a matching one)
   *   4. spawn cloudflared inside the container
   *   5. persist the record + meta
   *
   * Failure between (2) and (5) leaves the Cloudflare-side resources in
   * place. Later calls re-discover the tunnel with `findTunnelByName` and
   * reuse the DNS record through the CNAME upsert path.
   */
  async #provisionNamedTunnel(
    port: number,
    name: string
  ): Promise<NamedTunnelInfo> {
    await this.#resumePortCleanup(port);

    if (!this.#host.sandboxId) {
      throw new Error(
        'Named tunnels require host.sandboxId on the tunnels handler.'
      );
    }
    if (!this.#host.getNamedTunnelConfig) {
      throw new Error(
        'Named tunnels require host.getNamedTunnelConfig on the tunnels handler.'
      );
    }

    const config = await this.#host.getNamedTunnelConfig();
    const zoneName = await this.#getZoneName({
      token: config.token,
      zoneId: config.zoneId
    });
    const hostname = `${name}.${zoneName}`;
    const sandboxId = this.#host.sandboxId;
    const tunnelName = `sandbox-${sandboxId}-${name}`;

    // Step 2: reuse an existing tagged tunnel from an incomplete
    // provisioning attempt, otherwise create a fresh one.
    let tunnelId: string;
    let tunnelToken: string;
    const existingTunnel = await findTunnelByName({
      token: config.token,
      accountId: config.accountId,
      tunnelName,
      // Verify the tunnel's metadata.sandboxId tag matches this sandbox
      // before reusing it; defends against name collisions across
      // sandboxes.
      expectedSandboxId: sandboxId,
      fetcher: this.#host.fetcher
    });
    if (existingTunnel) {
      // Reuse the tagged tunnel from an incomplete provisioning attempt.
      // The opaque `--token` is only returned at create-time, so we fetch
      // it explicitly here. Re-POSTing the same name returns a conflict
      // from Cloudflare.
      tunnelId = existingTunnel.id;
      tunnelToken = await getTunnelToken({
        token: config.token,
        accountId: config.accountId,
        tunnelId,
        fetcher: this.#host.fetcher
      });
    } else {
      const created = await createTunnel({
        token: config.token,
        accountId: config.accountId,
        tunnelName,
        metadata: {
          sandboxId,
          createdBy: 'sandbox-sdk',
          name,
          port
        },
        fetcher: this.#host.fetcher
      });
      tunnelId = created.id;
      tunnelToken = created.token;
    }

    // Step 3: upsert the proxied CNAME. Throws on conflict before any
    // container work happens.
    const dnsResult = await upsertCNAME({
      token: config.token,
      zoneId: config.zoneId,
      hostname,
      cnameTarget: `${tunnelId}.cfargotunnel.com`,
      comment: `sandbox-${sandboxId}`,
      sandboxId,
      fetcher: this.#host.fetcher
    });

    // Step 4: spawn cloudflared. If this fails, both the tunnel and
    // the DNS record stay in place — see method-level docstring.
    const lifecycle = await this.#lifecycle.capture();
    await this.#host.client.tunnels.runNamedTunnel(tunnelId, tunnelToken, port);
    await this.#lifecycle.assertActive(lifecycle, 'process_ready', true);

    const info: NamedTunnelInfo = {
      id: tunnelId,
      port,
      name,
      hostname,
      url: `https://${hostname}`,
      createdAt: new Date().toISOString()
    };

    // Step 5: persist info + sidecar meta atomically.
    await this.#host.storage.transaction(async (txn) => {
      const nextMap = await readMap(txn);
      nextMap[port.toString()] = info;
      await txn.put(STORAGE_KEY, nextMap);
      const nextMeta = await readMetaMap(txn);
      nextMeta[port.toString()] = {
        optionsHash: computeOptionsHash({ name }),
        dnsRecordId: dnsResult.recordId,
        accountId: config.accountId,
        zoneId: config.zoneId,
        tunnelId,
        name,
        hostname,
        ...(lifecycle.runtime && {
          runtimeIdentityID: lifecycle.runtime.id
        }),
        ...(lifecycle.lifetime && {
          sandboxLifetimeID: lifecycle.lifetime.id
        })
      };
      await txn.put(META_STORAGE_KEY, nextMeta);
    });
    await this.#lifecycle.assertActive(lifecycle, 'committing', true);
    return info;
  }

  async destroy(portOrInfo: number | TunnelInfo): Promise<void> {
    const port = typeof portOrInfo === 'number' ? portOrInfo : portOrInfo.port;
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let tunnelId: string | undefined;
    try {
      await this.#withPortLock(port, async () => {
        const map = await readMap(this.#host.storage);
        const metaBefore = (await readMetaMap(this.#host.storage))[
          port.toString()
        ];
        const existing =
          map[port.toString()] ?? namedTunnelInfoFromMeta(port, metaBefore);
        if (!existing) {
          // Idempotent — destroying an unknown port resolves successfully.
          return;
        }
        tunnelId = existing.id;
        const cleanupEntry = createNamedTunnelCleanupEntry(
          existing,
          metaBefore
        );

        // Clear storage first. Same ordering as portTokens (sandbox.ts):
        // a hypothetical reader that observes storage between the put
        // below and the destroyTunnel RPC sees a cache miss — the right
        // answer, since the tunnel is on its way out. The port lock
        // means no in-process get(port) is racing with us, but Workers
        // / external readers don't go through this handler.
        await this.#host.storage.transaction(async (txn) => {
          const current = await readMap(txn);
          delete current[port.toString()];
          await txn.put(STORAGE_KEY, current);
          const currentMeta = await readMetaMap(txn);
          delete currentMeta[port.toString()];
          await txn.put(META_STORAGE_KEY, currentMeta);
          if (cleanupEntry) {
            const cleanup = await readCleanupMap(txn);
            cleanup[port.toString()] = cleanupEntry;
            await txn.put(CLEANUP_STORAGE_KEY, cleanup);
          }
        });

        // Stop cloudflared inside the container. This is best-effort for
        // named tunnels: destroy() is also responsible for Cloudflare-side
        // cleanup, which must still run if the container already stopped.
        try {
          await this.#host.client.tunnels.destroyTunnel(existing.id);
        } catch (error) {
          if (isTunnelNotFoundError(error)) {
            // Container already forgot — fall through to CF cleanup.
          } else if (metaBefore?.dnsRecordId) {
            this.#host.logger.warn(
              'tunnel.destroy: container tunnel cleanup failed',
              {
                port,
                tunnelId,
                error: error instanceof Error ? error.message : String(error)
              }
            );
          } else {
            throw error;
          }
        }

        // Quick tunnels have no Cloudflare-side resources to delete.
        if (!metaBefore?.dnsRecordId || !existing.name) return;

        if (!cleanupEntry) return;
        const cleaned = await cleanupNamedTunnelResources(
          this.#host,
          cleanupEntry,
          {
            logPrefix: 'tunnel.destroy',
            credentialsUnavailableMessage:
              'tunnel.destroy: skipping CF cleanup, credentials unavailable'
          }
        );
        if (!cleaned) return;

        await this.#host.storage.transaction(async (txn) => {
          const cleanup = await readCleanupMap(txn);
          delete cleanup[port.toString()];
          await txn.put(CLEANUP_STORAGE_KEY, cleanup);
        });
      });
      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.#host.logger, {
        event: 'tunnel.destroy',
        outcome,
        port,
        tunnelId,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  async list(): Promise<TunnelInfo[]> {
    const map = await readMap(this.#host.storage);
    const meta = await readMetaMap(this.#host.storage);
    return Object.entries(map)
      .filter(([port]) => !meta[port]?.needsRespawn)
      .map(([, info]) => info);
  }
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
  //
  // The lock is shared between the public `TunnelsRpcTarget` and the
  // private `handleTunnelExit` callback so an exit hook can't race a
  // concurrent get/destroy on the same port.
  const portLocks = new Map<number, Promise<unknown>>();

  const withPortLock: WithPortLock = <T>(
    port: number,
    fn: () => Promise<T>
  ): Promise<T> => {
    const previous = portLocks.get(port) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Swallow rejections on the chain so a failed op doesn't poison
    // subsequent ones; the original promise still rejects to the caller.
    portLocks.set(
      port,
      next.catch(() => undefined)
    );
    return next;
  };

  const tunnels = new TunnelsRpcTarget(host, withPortLock);

  const handleTunnelExit: TunnelExitHandler = async (id, port, exitCode) => {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      await withPortLock(port, async () => {
        await host.storage.transaction(async (txn) => {
          const map = await readMap(txn);
          const existing = map[port.toString()];
          // Defensive: only act if storage still references this exact
          // tunnel id. Exit callbacks for superseded tunnel processes
          // are ignored so current records stay intact.
          if (existing?.id !== id) return;

          if (existing.name) {
            // Named tunnel. The Cloudflare-side tunnel and DNS record
            // are still live; preserving meta (especially `dnsRecordId`,
            // `accountId`, `zoneId`) is what lets `get(port, { name })`
            // respawn the process and `destroy(port)` clean resources up
            // later. Hide the public record so list() only returns
            // tunnels with a current cloudflared process. Respawn is
            // driven by the next explicit get(port, { name }) call so
            // persistent cloudflared failures do not loop in the
            // background.
            await markNamedTunnelNeedsRespawn(txn, port.toString(), existing);
            return;
          }

          // Quick tunnel: the `*.trycloudflare.com` URL died with the
          // process and cannot be recovered. Drop both entries.
          delete map[port.toString()];
          await txn.put(STORAGE_KEY, map);
          const meta = await readMetaMap(txn);
          delete meta[port.toString()];
          await txn.put(META_STORAGE_KEY, meta);
        });
      });
      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(host.logger, {
        event: 'tunnel.exit',
        outcome,
        port,
        tunnelId: id,
        exitCode: exitCode ?? undefined,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  };

  const resumeCleanup = async (): Promise<void> => {
    await resumeNamedTunnelCleanupRecords(host, host.storage);
  };

  /**
   * Iterate every stored tunnel and call `tunnels.destroy(port)` on it,
   * sequentially. Each `destroy()` already swallows container-side
   * TUNNEL_NOT_FOUND and best-effort-logs Cloudflare-side failures; we
   * wrap the call in catch-and-log here too so a transport-level error
   * on one port can't poison the rest of the teardown.
   *
   * Each port is processed sequentially: this caps the *number of
   * concurrent ports* in flight at one. Note that an individual
   * destroy() still fans the DNS-delete and tunnel-delete out via
   * `Promise.allSettled` internally — so "sequential" here means
   * "one port at a time", not "one Cloudflare API call at a time".
   * The handful of ports we expect in the common case makes the
   * trade-off cheap.
   */
  const destroyAll = async (): Promise<void> => {
    const map = await readMap(host.storage);
    const ports = Object.keys(map).map((p) => Number(p));
    for (const port of ports) {
      try {
        await tunnels.destroy(port);
      } catch (err) {
        host.logger.warn('tunnels.destroyAll: destroy(port) failed', {
          port,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    await resumeCleanup();
  };

  return {
    tunnels,
    handleTunnelExit,
    destroyAll,
    resumeCleanup
  };
}
