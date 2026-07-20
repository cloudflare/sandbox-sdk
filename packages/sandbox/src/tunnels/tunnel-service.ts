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
import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import { OperationInterruptedError } from '../errors';
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
  createTunnelInterruptedError,
  TunnelOperationLifecycle
} from './lifecycle';
import { TunnelProvisioner, type TunnelRuntimeCall } from './provisioner';
import { randomId } from './random-id';
import { pruneTunnelsForRestart } from './restart';
import type { TunnelCleanupEntry, TunnelsStorage } from './storage';
import {
  CLEANUP_STORAGE_KEY,
  computeOptionsHash,
  createNamedTunnelCleanupEntry,
  effectiveOptionsHash,
  META_STORAGE_KEY,
  markCleanupDNSReady,
  markCleanupTunnelReady,
  namedRespawnMeta,
  namedTunnelInfoFromMeta,
  optionsHashesEqual,
  readMap,
  readMetaMap,
  readPortState,
  STORAGE_KEY,
  tunnelConfigChanged,
  updatePortState
} from './storage';

export type { TunnelsStorage, TunnelsStorageTxn } from './storage';

/** Subset of the Sandbox DO the service reads from. */
export interface TunnelServiceHost {
  runRuntimeCall: TunnelRuntimeCall;
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
  /** Stop stored container-side tunnel runs without mutating durable state. */
  destroyAllRuntimeRuns: () => Promise<void>;
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

interface TunnelGetRecoveryState {
  quickRun?: {
    tunnelId: string;
    runId: string;
  };
}

function createTunnelRunId(): string {
  return `run-${randomId()}`;
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

      const recovery: TunnelGetRecoveryState = {};
      const result = await this.#withPortLock(port, async () => {
        try {
          return await this.#getLocked(port, options, requestedHash, recovery);
        } catch (error) {
          if (error instanceof RuntimeIdentityInactiveError) {
            throw createTunnelInterruptedError({
              reason: 'runtime_replaced',
              phase: 'process_ready',
              admitted: 'unknown',
              retryable: false,
              message:
                'Tunnel operation was interrupted by a runtime replacement'
            });
          }
          throw error;
        }
      });
      cacheState = result.cacheState;
      outcome = 'success';
      return result.info;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      if (caughtError instanceof OperationInterruptedError) {
        // Ensure retryable is false since we do not recover
        caughtError.context.retryable = false;
      }
      throw caughtError;
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
    requestedHash: string,
    recovery: TunnelGetRecoveryState
  ): Promise<TunnelGetResult> {
    const state = await readPortState(this.#host.storage, port);
    const existing = state.info;
    const metaEntry = state.meta;

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
              : await this.#provisionQuickTunnel(port, recovery),
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
        : await this.#provisionQuickTunnel(port, recovery),
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
    const entry = (await readPortState(this.#host.storage, port)).cleanup;
    if (!entry) return;

    if (
      !(await resumeNamedTunnelCleanupEntry(
        this.#host,
        this.#host.storage,
        port.toString(),
        entry
      ))
    ) {
      throw new Error(
        `Pending named tunnel cleanup for port ${port} could not complete.`
      );
    }
  }

  async #updatePortCleanup(
    port: number,
    next: (entry: TunnelCleanupEntry | undefined) => TunnelCleanupEntry
  ): Promise<void> {
    await updatePortState(this.#host.storage, port, (state) => ({
      cleanup: next(state.cleanup)
    }));
  }

  #requireCleanupEntry(
    port: number,
    entry: TunnelCleanupEntry | undefined
  ): TunnelCleanupEntry {
    if (entry) return entry;
    throw new Error(`Missing named tunnel cleanup intent for port ${port}`);
  }

  /** Provision a fresh quick tunnel and persist it. Caller holds the per-port lock. */
  async #provisionQuickTunnel(
    port: number,
    recovery: TunnelGetRecoveryState
  ): Promise<QuickTunnelInfo> {
    let lifecycle = await this.#lifecycle.capture();
    recovery.quickRun ??= {
      tunnelId: `quick-${randomId()}`,
      runId: createTunnelRunId()
    };
    const { tunnelId, runId } = recovery.quickRun;
    const spawned = await this.#provisioner.provisionQuickTunnel(
      port,
      runId,
      tunnelId
    );
    lifecycle = await this.#lifecycle.requireRuntime(
      lifecycle,
      'process_ready',
      true
    );
    await this.#lifecycle.assertActive(lifecycle, 'process_ready', true);
    await updatePortState(this.#host.storage, port, () => ({
      info: spawned,
      meta: {
        optionsHash: 'v1:quick',
        ...(lifecycle.runtime && {
          runtimeIdentityID: lifecycle.runtime.id
        }),
        ...(lifecycle.lifetime && {
          sandboxLifetimeID: lifecycle.lifetime.id
        }),
        tunnelRunId: runId
      }
    }));
    await this.#lifecycle.assertActive(lifecycle, 'committing', true);
    return spawned;
  }

  async #provisionNamedTunnel(
    port: number,
    name: string
  ): Promise<NamedTunnelInfo> {
    let lifecycle = await this.#lifecycle.capture();

    await this.#resumePortCleanup(port);

    const prepared = await this.#provisioner.prepareNamedTunnel(port, name, {
      onIntentReady: (entry) => this.#updatePortCleanup(port, () => entry),
      onTunnelReady: (tunnelId) =>
        this.#updatePortCleanup(port, (entry) =>
          markCleanupTunnelReady(
            this.#requireCleanupEntry(port, entry),
            tunnelId
          )
        ),
      onDNSReady: (dnsRecordId) =>
        this.#updatePortCleanup(port, (entry) =>
          markCleanupDNSReady(
            this.#requireCleanupEntry(port, entry),
            dnsRecordId
          )
        )
    });
    const cleanupEntry = createNamedTunnelCleanupEntry(
      prepared.info,
      prepared.meta
    );
    if (cleanupEntry) {
      await updatePortState(this.#host.storage, port, () => ({
        cleanup: cleanupEntry
      }));
    }
    await this.#lifecycle.assertActive(
      lifecycle,
      'cloudflare_ready',
      'unknown'
    );

    const tunnelRunId = createTunnelRunId();
    await this.#provisioner.startNamedTunnelRun(prepared, tunnelRunId);
    lifecycle = await this.#lifecycle.requireRuntime(
      lifecycle,
      'process_ready',
      true
    );
    await this.#lifecycle.assertActive(lifecycle, 'process_ready', true);

    await updatePortState(this.#host.storage, port, () => ({
      info: prepared.info,
      meta: {
        ...prepared.meta,
        ...(lifecycle.runtime && {
          runtimeIdentityID: lifecycle.runtime.id
        }),
        ...(lifecycle.lifetime && {
          sandboxLifetimeID: lifecycle.lifetime.id
        }),
        tunnelRunId
      },
      cleanup: undefined
    }));
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
        const portKey = port.toString();
        const current = await readPortState(this.#host.storage, port);
        const existing =
          current.info ?? namedTunnelInfoFromMeta(port, current.meta);
        if (!existing) {
          if (current.cleanup) {
            await resumeNamedTunnelCleanupEntry(
              this.#host,
              this.#host.storage,
              portKey,
              current.cleanup,
              {
                logPrefix: 'tunnel.destroy',
                credentialsUnavailableMessage:
                  'tunnel.destroy: skipping CF cleanup, credentials unavailable'
              }
            );
          }
          return;
        }
        tunnelId = existing.id;
        const cleanupEntry = createNamedTunnelCleanupEntry(
          existing,
          current.meta
        );

        await updatePortState(this.#host.storage, port, () => ({
          info: undefined,
          meta: undefined,
          ...(cleanupEntry && { cleanup: cleanupEntry })
        }));

        try {
          if (current.meta?.tunnelRunId) {
            const tunnelRunId = current.meta.tunnelRunId;
            await this.#host.runRuntimeCall('tunnel.stopRun', (tunnels) =>
              tunnels.stopTunnelRun({
                tunnelId: existing.id,
                runId: tunnelRunId
              })
            );
          }
        } catch (error) {
          if (isTunnelNotFoundError(error)) {
            // Container already forgot — fall through to CF cleanup.
          } else if (current.meta?.dnsRecordId) {
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

        if (!current.meta?.dnsRecordId || !existing.name || !cleanupEntry) {
          return;
        }
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

        await updatePortState(this.#host.storage, port, () => ({
          cleanup: undefined
        }));
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
        await updatePortState(this.#host.storage, port, (state) => {
          const existing = state.info;
          const meta = state.meta;
          if (existing?.id !== id) return undefined;
          if (meta?.tunnelRunId && tunnelRunId !== meta.tunnelRunId) {
            return undefined;
          }

          return {
            info: undefined,
            meta: existing.name ? namedRespawnMeta(existing, meta) : undefined
          };
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
    const ports = await this.destroyAllPorts();

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

  async destroyAllRuntimeRuns(): Promise<void> {
    const map = await readMap(this.#host.storage);
    const meta = await readMetaMap(this.#host.storage);
    const ports = await this.destroyAllPorts();
    for (const port of ports) {
      const info = map[String(port)];
      const runId = meta[String(port)]?.tunnelRunId;
      if (!info || !runId) continue;
      try {
        await this.#host.runRuntimeCall('tunnel.stopRun', (tunnels) =>
          tunnels.stopTunnelRun({ tunnelId: info.id, runId })
        );
      } catch (error) {
        if (isTunnelNotFoundError(error)) continue;
        this.#host.logger.warn('tunnels.destroyAllRuntimeRuns: stop failed', {
          port,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async destroyAllPorts(): Promise<Set<number>> {
    const map = await readMap(this.#host.storage);
    const meta = await readMetaMap(this.#host.storage);
    const ports = new Set(Object.keys(map).map((p) => Number(p)));
    for (const [portKey, entry] of Object.entries(meta)) {
      const port = Number(portKey);
      if (Number.isFinite(port) && namedTunnelInfoFromMeta(port, entry)) {
        ports.add(port);
      }
    }
    return ports;
  }

  async onRuntimeStart(): Promise<void> {
    await pruneTunnelsForRestart(this.#host.storage);
    await this.resumeCleanup();
  }

  async onRuntimeStop(): Promise<void> {
    await pruneTunnelsForRestart(this.#host.storage);
  }

  async clearDurableStateAfterDestroy(): Promise<void> {
    await Promise.all([
      this.#host.storage.delete(STORAGE_KEY),
      this.#host.storage.delete(META_STORAGE_KEY),
      this.#host.storage.delete(CLEANUP_STORAGE_KEY)
    ]);
  }
}
