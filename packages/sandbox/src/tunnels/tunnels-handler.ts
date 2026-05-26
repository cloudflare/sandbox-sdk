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
import {
  SandboxSecurityError,
  validatePort,
  validateTunnelName
} from '../security';
import {
  createTunnel,
  deleteDNSRecord,
  deleteTunnel,
  findTunnelByName,
  getTunnelToken,
  getZoneName,
  upsertCNAME
} from './cloudflare-api';

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
}

/** DO storage key for the `port → TunnelInfo` map. */
const STORAGE_KEY = 'tunnels';

/**
 * Sidecar storage key for per-port metadata the handler needs but the
 * public `TunnelInfo` shape does not carry: the options hash used to
 * detect divergent retries, and (for named tunnels) the DNS record id
 * needed for cleanup. Kept under a separate key so the existing
 * `tunnels` shape remains a clean `Record<port, TunnelInfo>`.
 */
const META_STORAGE_KEY = 'tunnels:meta';

type TunnelMap = Record<string, TunnelInfo>;

interface TunnelMetaEntry {
  /** Stable hash of the `options` object the tunnel was created with. */
  optionsHash: string;
  /** Cloudflare DNS record id for named tunnels; absent for quick. */
  dnsRecordId?: string;
  /**
   * Resolved `(accountId, zoneId)` the named tunnel was provisioned
   * against. Compared on cache hit to detect env-var changes that
   * would otherwise silently serve a stale URL (the cached
   * `TunnelInfo.hostname` is `<name>.<old-zone-name>` and would no
   * longer resolve to a live tunnel). Absent on quick tunnels.
   */
  accountId?: string;
  zoneId?: string;
  /**
   * Set by `pruneTunnelsForRestart` on container restart for named
   * tunnels. The Cloudflare-side resources (tunnel + DNS) survive the
   * restart, but the `cloudflared` process inside the container died
   * with it. The next `get(port, { name })` call sees this flag on a
   * cache hit and falls through to `#provisionNamedTunnel`, which
   * reuses the existing tunnel via `findTunnelByName` and respawns
   * `cloudflared`. Absent on quick tunnels (which are dropped from
   * storage outright on restart).
   */
  needsRespawn?: boolean;
}

type TunnelMetaMap = Record<string, TunnelMetaEntry>;

/** Per-port serializer shared between `TunnelsRpcTarget` and the exit hook. */
type WithPortLock = <T>(port: number, fn: () => Promise<T>) => Promise<T>;

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
 * Previous versions matched by substring on `error.message`, which
 * false-positived on any error whose message merely quoted the literal
 * code token.
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

async function readMap(storage: TunnelsStorageTxn): Promise<TunnelMap> {
  return (await storage.get<TunnelMap>(STORAGE_KEY)) ?? {};
}

async function readMetaMap(storage: TunnelsStorageTxn): Promise<TunnelMetaMap> {
  return (await storage.get<TunnelMetaMap>(META_STORAGE_KEY)) ?? {};
}

/**
 * Stable hash of `options`. Empty/undefined options collapse to the same
 * hash so `get(port)`, `get(port, {})`, and `get(port, { name: undefined })`
 * all hit the same cache entry. Named tunnels hash on `name` alone (the
 * only option today).
 *
 * The `v1:` prefix exists so a future addition of a second option (e.g.
 * `subdomain`) can change the canonical form without colliding with an
 * older record's hash. Comparison goes through `optionsHashesEqual`, which
 * normalises legacy unversioned hashes (`quick`, `named:foo`) to their v1
 * form before equality, so upgrading does not invalidate cached records.
 */
function computeOptionsHash(options?: TunnelOptions): string {
  if (!options || !options.name) return 'v1:quick';
  return `v1:named:${options.name}`;
}

/** Strip the optional `v1:` prefix so legacy hashes compare equal. */
function normaliseHash(hash: string): string {
  return hash.startsWith('v1:') ? hash.slice(3) : hash;
}

function optionsHashesEqual(a: string, b: string): boolean {
  return normaliseHash(a) === normaliseHash(b);
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
  /**
   * Memoised zone name (e.g. `'example.com'`) for the configured
   * `CLOUDFLARE_ZONE_ID`. Filled in lazily on the first named-tunnel
   * `get()` so quick-tunnel callers never hit the zone-lookup endpoint.
   *
   * Only successful resolutions are cached: a rejected lookup clears
   * the slot so the next caller retries, instead of permanently
   * poisoning every subsequent named-tunnel `get()` on the DO with the
   * same transient error.
   */
  #zoneNamePromise: Promise<string> | null = null;

  constructor(host: TunnelsHandlerHost, withPortLock: WithPortLock) {
    super();
    this.#host = host;
    this.#withPortLock = withPortLock;
  }

  /**
   * Resolve the zone name for the configured zone id. Memoised for the
   * lifetime of this handler; the zone name doesn't change while a DO
   * is alive, and one extra GET on first use is cheaper than threading
   * the value through the host.
   *
   * On failure the cached promise is cleared so the next caller retries.
   * Without that, a transient 5xx on the first call would permanently
   * poison every subsequent named-tunnel `get()` until the DO restarts.
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
    let cacheState: 'hit' | 'miss' = 'miss';
    let caughtError: Error | undefined;
    try {
      validateTunnelPort(port);
      if (options?.name !== undefined) validateTunnelName(options.name);
      const requestedHash = computeOptionsHash(options);

      const info = await this.#withPortLock(port, async () => {
        const map = await readMap(this.#host.storage);
        const existing = map[port.toString()];
        if (existing) {
          const meta = await readMetaMap(this.#host.storage);
          const metaEntry = meta[port.toString()];
          const cachedHash = metaEntry?.optionsHash;
          // Quick tunnels created before the meta sidecar shipped, or
          // any port whose meta entry was lost, fall back to comparing
          // by discriminator alone so cache hits keep working.
          const effectiveHash =
            cachedHash ??
            (existing.name ? `v1:named:${existing.name}` : 'v1:quick');
          if (!optionsHashesEqual(effectiveHash, requestedHash)) {
            throw new Error(
              `Tunnel on port ${port} was created with different options. ` +
                `Call destroy(${port}) before changing tunnel options.`
            );
          }
          // Container restart marker: the CF-side tunnel + DNS still
          // exist, but `cloudflared` died with the container. Fall
          // through to the named-tunnel provision path, which reuses
          // the tagged tunnel via `findTunnelByName` and respawns the
          // process. Only named tunnels get this branch; quick tunnels
          // were dropped from storage by `pruneTunnelsForRestart`.
          if (metaEntry?.needsRespawn && existing.name) {
            return await this.#provisionNamedTunnel(port, existing.name);
          }
          // Config-drift check for named tunnels: if CLOUDFLARE_ZONE_ID
          // (or the resolved account id) changed since the tunnel was
          // provisioned, the cached `hostname` is stale and would no
          // longer resolve. Re-provision against the current config;
          // `#provisionNamedTunnel` handles tunnel + DNS reuse via the
          // `findTunnelByName` and `upsertCNAME` paths.
          if (existing.name && this.#host.getNamedTunnelConfig) {
            const currentConfig = await this.#host.getNamedTunnelConfig();
            const storedAccountId = metaEntry?.accountId;
            const storedZoneId = metaEntry?.zoneId;
            if (
              (storedAccountId !== undefined &&
                storedAccountId !== currentConfig.accountId) ||
              (storedZoneId !== undefined &&
                storedZoneId !== currentConfig.zoneId)
            ) {
              // The cached zone name is for the old zone id; clear it
              // so `#provisionNamedTunnel` re-resolves against the new
              // one. Without this, `hostname` would be `<name>.<old
              // zone name>` even after re-provision.
              this.#zoneNamePromise = null;
              return await this.#provisionNamedTunnel(port, existing.name);
            }
          }
          cacheState = 'hit';
          return existing;
        }

        if (options?.name) {
          return await this.#provisionNamedTunnel(port, options.name);
        }
        return await this.#provisionQuickTunnel(port);
      });
      outcome = 'success';
      return info;
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

  /**
   * Provision a fresh quick tunnel and persist it. Caller holds the
   * per-port lock.
   *
   * Quick-tunnel ids are minted from a 32-bit random source. Collisions
   * are astronomically unlikely, but if the container happens to already
   * have one running under the freshly-minted id it rejects with
   * TUNNEL_ALREADY_RUNNING. Mint a fresh id and try again rather than
   * surfacing the confusing error — the retry budget caps the loop so a
   * persistent failure still surfaces.
   */
  async #provisionQuickTunnel(port: number): Promise<QuickTunnelInfo> {
    const MAX_ID_RETRIES = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt += 1) {
      const id = `quick-${shortId()}`;
      try {
        const spawned = (await this.#host.client.tunnels.runQuickTunnel(
          id,
          port
        )) as QuickTunnelInfo;
        await this.#host.storage.transaction(async (txn) => {
          const nextMap = await readMap(txn);
          nextMap[port.toString()] = spawned;
          await txn.put(STORAGE_KEY, nextMap);
          const nextMeta = await readMetaMap(txn);
          nextMeta[port.toString()] = { optionsHash: 'v1:quick' };
          await txn.put(META_STORAGE_KEY, nextMeta);
        });
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
   * Failure between (2) and (5) intentionally leaves the Cloudflare-side
   * resources in place so a retry can re-discover them via
   * `findTunnelByName` and the DNS reuse path. See
   * `.plans/09-named-tunnel-api.md § Retry-friendly failure model`.
   */
  async #provisionNamedTunnel(
    port: number,
    name: string
  ): Promise<NamedTunnelInfo> {
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

    // Step 2: reuse an existing tagged tunnel if one is left over from
    // a previous failed attempt, otherwise create a fresh one.
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
      // Reuse the tagged tunnel left over from a previous failed attempt.
      // The opaque `--token` is only returned at create-time, so we fetch
      // it explicitly here. Re-POSTing the same name would 409 on
      // Cloudflare's side.
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
    await this.#host.client.tunnels.runNamedTunnel(tunnelId, tunnelToken, port);

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
        zoneId: config.zoneId
      };
      await txn.put(META_STORAGE_KEY, nextMeta);
    });
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
        const existing = map[port.toString()];
        if (!existing) {
          // Idempotent — destroying an unknown port resolves successfully.
          return;
        }
        tunnelId = existing.id;
        const metaBefore = (await readMetaMap(this.#host.storage))[
          port.toString()
        ];

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
        });

        // Stop cloudflared inside the container. TUNNEL_NOT_FOUND is
        // swallowed so Cloudflare-side cleanup can still proceed.
        try {
          await this.#host.client.tunnels.destroyTunnel(existing.id);
        } catch (error) {
          if (!isTunnelNotFoundError(error)) throw error;
          // Container already forgot — fall through to CF cleanup.
        }

        // Named-tunnel cleanup on Cloudflare. Best-effort: log failures
        // but do not abort the rest of teardown. Quick tunnels short-circuit
        // here because they have no CF-side resources.
        // Quick tunnels short-circuit here — no DNS record id means there
        // are no Cloudflare-side resources to delete.
        if (!metaBefore?.dnsRecordId) return;
        if (!this.#host.getNamedTunnelConfig) return;

        let config: { token: string; accountId: string; zoneId: string };
        try {
          config = await this.#host.getNamedTunnelConfig();
        } catch (err) {
          // CF cleanup is skipped; surface the orphaned resource ids so
          // an operator can clean up by hand. Without dnsRecordId in
          // particular, the leaked CNAME is hard to find from the
          // dashboard without grepping by tunnel target.
          this.#host.logger.warn(
            'tunnel.destroy: skipping CF cleanup, credentials unavailable',
            {
              port,
              tunnelId,
              dnsRecordId: metaBefore.dnsRecordId,
              error: err instanceof Error ? err.message : String(err)
            }
          );
          return;
        }

        const fetcher = this.#host.fetcher;
        await Promise.allSettled([
          metaBefore.dnsRecordId
            ? deleteDNSRecord({
                token: config.token,
                zoneId: config.zoneId,
                recordId: metaBefore.dnsRecordId,
                fetcher
              }).catch((err) => {
                this.#host.logger.warn('tunnel.destroy: dns delete failed', {
                  port,
                  tunnelId,
                  recordId: metaBefore.dnsRecordId,
                  error: err instanceof Error ? err.message : String(err)
                });
              })
            : Promise.resolve(),
          deleteTunnel({
            token: config.token,
            accountId: config.accountId,
            tunnelId: existing.id,
            fetcher
          }).catch((err) => {
            this.#host.logger.warn('tunnel.destroy: tunnel delete failed', {
              port,
              tunnelId,
              error: err instanceof Error ? err.message : String(err)
            });
          })
        ]);
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
    return Object.values(map);
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
          // Defensive: only clear if storage still references this exact
          // tunnel id. Without this check, a sequence like "old
          // cloudflared dies → new get() spawns fresh → old callback
          // fires" would clobber the new record.
          if (existing?.id === id) {
            delete map[port.toString()];
            await txn.put(STORAGE_KEY, map);
            const meta = await readMetaMap(txn);
            delete meta[port.toString()];
            await txn.put(META_STORAGE_KEY, meta);
          }
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
  };

  return {
    tunnels,
    handleTunnelExit,
    destroyAll
  };
}

/**
 * Reconcile storage with a fresh container.
 *
 * Called from `Sandbox.onStart()` after every container restart. The
 * `cloudflared` processes the container was running all died with it, so
 * any stored record is *not* currently backed by a running tunnel.
 *
 * Two tunnel flavours, two recovery stories:
 *
 *   - Quick tunnels: the `*.trycloudflare.com` URL is bound to the dead
 *     `cloudflared` process. Nothing on Cloudflare's side outlives the
 *     container, and the URL is unrecoverable. Drop the record from both
 *     maps so the next `get(port)` takes the miss branch and mints a new
 *     URL.
 *   - Named tunnels: the Cloudflare-side tunnel + DNS record survive.
 *     The hostname is stable, the DNS still resolves to
 *     `<tunnelId>.cfargotunnel.com`, and the next caller can reuse both
 *     by walking the same `findTunnelByName` / `upsertCNAME` path the
 *     SDK uses for retries. Keep the record in storage and mark the
 *     meta entry `needsRespawn: true`; the next `get(port, { name })`
 *     cache hit falls through to `#provisionNamedTunnel` to respawn
 *     `cloudflared`.
 *
 * Crucially, named-tunnel metadata (including `dnsRecordId`) is
 * preserved so `destroy(port)` and `sandbox.destroy()` can still clean
 * up the Cloudflare-side resources after a restart. Wiping meta
 * unconditionally — the previous behaviour — silently leaked the tunnel
 * and DNS record on every restart.
 */
export async function pruneTunnelsForRestart(
  storage: TunnelsStorage
): Promise<void> {
  await storage.transaction(async (txn) => {
    const map = await readMap(txn);
    const meta = await readMetaMap(txn);
    const nextMap: TunnelMap = {};
    const nextMeta: TunnelMetaMap = {};
    for (const [portKey, info] of Object.entries(map)) {
      // Discriminate by the public `name` field on `TunnelInfo`: named
      // tunnels carry the user-provided label, quick tunnels omit it.
      if (info.name) {
        nextMap[portKey] = info;
        nextMeta[portKey] = {
          ...(meta[portKey] ?? { optionsHash: `v1:named:${info.name}` }),
          needsRespawn: true
        };
      }
      // Quick tunnels are dropped from both maps by omission.
    }
    await txn.put(STORAGE_KEY, nextMap);
    await txn.put(META_STORAGE_KEY, nextMeta);
  });
}
