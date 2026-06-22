/**
 * Tunnel domain service. Owns public tunnel operations, runtime restart
 * reconciliation, process-exit handling, and durable named-resource cleanup.
 */

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
import { TunnelOperationLifecycle } from './lifecycle';
import { TunnelProvisioner } from './provisioner';
import { pruneTunnelsForRestart } from './restart';
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

export type { TunnelsStorage, TunnelsStorageTxn } from './storage';

/** Subset of the RPC client this service depends on. */
interface TunnelsRPCClient {
  tunnels: SandboxTunnelsAPI;
}

/** Subset of the Sandbox DO the service reads from. */
export interface TunnelServiceHost {
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
   * provisioning. The service calls it when validating named cache
   * entries and when preparing named tunnel resources.
   *
   * Throws (via the underlying resolver) when any required value is
   * missing or unresolvable. The service surfaces that error verbatim.
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
  currentRuntime?: Pick<CurrentRuntimeIdentity, 'get' | 'assertActive'>;
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
  exitCode: number | null,
  tunnelRunId?: string
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
  /** Reconcile durable tunnel state after a fresh container runtime starts. */
  onRuntimeStart: () => Promise<void>;
  /** Reconcile durable tunnel state after the container runtime stops. */
  onRuntimeStop: () => Promise<void>;
  /** Clear public tunnel state after sandbox destroy processing completes. */
  clearDurableStateAfterDestroy: () => Promise<void>;
}

/** Per-port serializer shared by public operations and exit hooks. */
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

/**
 * Match a structured SandboxError code anywhere on the error — translated
 * SandboxErrors expose the code both as a top-level `code` field and on
 * the nested `errorResponse.code`. Used for SDK-recognized container
 * errors that have operation-specific recovery behavior.
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

function createTunnelRunId(): string {
  return crypto.randomUUID();
}

/** Tunnel domain façade for public operations and lifecycle hooks. */
export class TunnelService implements TunnelsHandler {
  readonly #host: TunnelServiceHost;
  readonly #portLocks = new Map<number, Promise<unknown>>();
  readonly #lifecycle: TunnelOperationLifecycle;
  readonly #provisioner: TunnelProvisioner;

  constructor(host: TunnelServiceHost) {
    this.#host = host;
    this.#lifecycle = new TunnelOperationLifecycle(host);
    this.#provisioner = new TunnelProvisioner(host);
  }

  #withPortLock: WithPortLock = <T>(
    port: number,
    fn: () => Promise<T>
  ): Promise<T> => {
    const previous = this.#portLocks.get(port) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#portLocks.set(
      port,
      next.catch(() => undefined)
    );
    return next;
  };

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
          this.#provisioner.clearCachedZoneName();
          return {
            info: await this.#provisionNamedTunnel(port, existing.name),
            cacheState: 'miss'
          };
        }
      }

      if (this.#host.currentRuntime) {
        const currentRuntime = await this.#host.currentRuntime.get();
        if (
          !metaEntry?.runtimeIdentityID ||
          currentRuntime?.id !== metaEntry.runtimeIdentityID
        ) {
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

  /** Provision a fresh quick tunnel and persist it. Caller holds the per-port lock. */
  async #provisionQuickTunnel(port: number): Promise<QuickTunnelInfo> {
    let lifecycle = await this.#lifecycle.capture();
    const tunnelRunId = createTunnelRunId();
    const spawned = await this.#provisioner.provisionQuickTunnel(
      port,
      tunnelRunId
    );
    lifecycle = await this.#lifecycle.requireRuntime(
      lifecycle,
      'process_ready',
      true
    );
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
        }),
        tunnelRunId
      };
      await txn.put(META_STORAGE_KEY, nextMeta);
    });
    await this.#lifecycle.assertActive(lifecycle, 'committing', true);
    return spawned;
  }

  async #provisionNamedTunnel(
    port: number,
    name: string
  ): Promise<NamedTunnelInfo> {
    let lifecycle = await this.#lifecycle.capture();

    await this.#resumePortCleanup(port);

    const prepared = await this.#provisioner.prepareNamedTunnel(port, name);
    const cleanupEntry = createNamedTunnelCleanupEntry(
      prepared.info,
      prepared.meta
    );
    if (cleanupEntry) {
      await this.#host.storage.transaction(async (txn) => {
        const cleanup = await readCleanupMap(txn);
        cleanup[port.toString()] = cleanupEntry;
        await txn.put(CLEANUP_STORAGE_KEY, cleanup);
      });
    }
    await this.#lifecycle.assertActive(
      lifecycle,
      'cloudflare_ready',
      'unknown'
    );

    const tunnelRunId = createTunnelRunId();
    await this.#provisioner.runNamedTunnel(prepared, tunnelRunId);
    lifecycle = await this.#lifecycle.requireRuntime(
      lifecycle,
      'process_ready',
      true
    );
    await this.#lifecycle.assertActive(lifecycle, 'process_ready', true);

    await this.#host.storage.transaction(async (txn) => {
      const nextMap = await readMap(txn);
      nextMap[port.toString()] = prepared.info;
      await txn.put(STORAGE_KEY, nextMap);
      const nextMeta = await readMetaMap(txn);
      nextMeta[port.toString()] = {
        ...prepared.meta,
        ...(lifecycle.runtime && {
          runtimeIdentityID: lifecycle.runtime.id
        }),
        ...(lifecycle.lifetime && {
          sandboxLifetimeID: lifecycle.lifetime.id
        }),
        tunnelRunId
      };
      await txn.put(META_STORAGE_KEY, nextMeta);
      const cleanup = await readCleanupMap(txn);
      delete cleanup[port.toString()];
      await txn.put(CLEANUP_STORAGE_KEY, cleanup);
    });
    await this.#lifecycle.assertActive(lifecycle, 'committing', true);
    return prepared.info;
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
        // / external readers do not share this in-memory lock.
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

  async onTunnelExit(
    id: string,
    port: number,
    exitCode: number | null,
    tunnelRunId?: string
  ): Promise<void> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      await this.#withPortLock(port, async () => {
        await this.#host.storage.transaction(async (txn) => {
          const map = await readMap(txn);
          const existing = map[port.toString()];
          const meta = await readMetaMap(txn);
          const metaEntry = meta[port.toString()];
          // Defensive: only act if storage still references this exact
          // tunnel id. Exit callbacks for superseded tunnel processes
          // are ignored so current records stay intact.
          if (existing?.id !== id) return;
          if (metaEntry?.tunnelRunId && tunnelRunId !== metaEntry.tunnelRunId) {
            return;
          }

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
          delete meta[port.toString()];
          await txn.put(META_STORAGE_KEY, meta);
        });
      });
      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.#host.logger, {
        event: 'tunnel.exit',
        outcome,
        port,
        tunnelId: id,
        exitCode: exitCode ?? undefined,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  async resumeCleanup(): Promise<void> {
    await resumeNamedTunnelCleanupRecords(this.#host, this.#host.storage);
  }

  async destroyAll(): Promise<void> {
    const map = await readMap(this.#host.storage);
    const meta = await readMetaMap(this.#host.storage);
    const ports = new Set(Object.keys(map).map((p) => Number(p)));
    for (const [portKey, entry] of Object.entries(meta)) {
      const port = Number(portKey);
      if (Number.isFinite(port) && namedTunnelInfoFromMeta(port, entry)) {
        ports.add(port);
      }
    }

    for (const port of ports) {
      try {
        await this.destroy(port);
      } catch (err) {
        this.#host.logger.warn('tunnels.destroyAll: destroy(port) failed', {
          port,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    await this.resumeCleanup();
  }

  async onRuntimeStart(): Promise<void> {
    await pruneTunnelsForRestart(this.#host.storage);
    await this.resumeCleanup();
  }

  async onRuntimeStop(): Promise<void> {
    await pruneTunnelsForRestart(this.#host.storage);
  }

  async clearDurableStateAfterDestroy(): Promise<void> {
    await this.#host.storage.delete(STORAGE_KEY);
    await this.#host.storage.delete(META_STORAGE_KEY);
  }
}
