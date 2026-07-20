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
import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import {
  OperationInterruptedError,
  RuntimeControlProtocolError
} from '../errors';
import {
  RuntimeIdentity,
  type RuntimeLease,
  type RuntimeRecordStorage
} from '../runtime';
import type {
  CurrentSandboxLifetime,
  SandboxLifetime
} from '../sandbox-lifetime';
import { SandboxLifetimeChangedError } from '../sandbox-lifetime';
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
import { createTunnelInterruptedError } from './lifecycle';
import { TunnelProvisioner } from './provisioner';
import { randomId } from './random-id';
import { pruneTunnelsForRestart } from './restart';
import type {
  TunnelCleanupEntry,
  TunnelMetaEntry,
  TunnelsStorage
} from './storage';
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
export type TunnelProvisionLease = Pick<RuntimeLease, 'runtime' | 'retain'> & {
  tunnels: SandboxTunnelsAPI;
};

export type TunnelExistingRuntimeCall = <T>(
  runtime: RuntimeIdentity,
  operation: string,
  call: (tunnels: SandboxTunnelsAPI) => Promise<T>
) => Promise<T | null>;

export interface TunnelServiceHost {
  runProvision<T>(
    call: (lease: TunnelProvisionLease) => Promise<T>
  ): Promise<T>;
  runExisting: TunnelExistingRuntimeCall;
  getStoredRuntime(
    storage?: RuntimeRecordStorage
  ): Promise<RuntimeIdentity | null>;
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
  tunnelRunId: string,
  runtime: RuntimeIdentity,
  isSessionCurrent: () => boolean
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

function tunnelMetaOwnsRuntime(
  meta: TunnelMetaEntry | undefined,
  runtime: RuntimeIdentity | null
): boolean {
  return Boolean(
    runtime &&
    meta?.runtimeIdentityID === runtime.id &&
    meta.runtimeIncarnationID === runtime.runtimeIncarnationID
  );
}

function tunnelOwningRuntime(
  meta: TunnelMetaEntry | undefined
): RuntimeIdentity | null {
  if (!meta?.runtimeIdentityID || !meta.runtimeIncarnationID) return null;
  return new RuntimeIdentity({
    id: meta.runtimeIdentityID,
    runtimeIncarnationID: meta.runtimeIncarnationID
  });
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

function isRuntimeActivationMismatch(error: unknown): boolean {
  return (
    error instanceof RuntimeControlProtocolError &&
    error.context.reason === 'activation-mismatch'
  );
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
  readonly #provisioner: TunnelProvisioner;

  constructor(host: TunnelServiceHost) {
    this.#host = host;
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
      const result = await this.#withPortLock(port, () =>
        this.#getLocked(port, options, requestedHash, recovery)
      );
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

      const currentRuntime = await this.#host.getStoredRuntime();
      if (
        !tunnelMetaOwnsRuntime(metaEntry, currentRuntime) ||
        !(await this.#validateCachedRuntime(currentRuntime))
      ) {
        return {
          info: existing.name
            ? await this.#provisionNamedTunnel(port, existing.name)
            : await this.#provisionQuickTunnel(port, recovery),
          cacheState: 'miss'
        };
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

  async #validateCachedRuntime(
    runtime: RuntimeIdentity | null
  ): Promise<boolean> {
    if (!runtime) return false;
    try {
      return (
        (await this.#host.runExisting(
          runtime,
          'tunnel.lookup',
          async () => true
        )) === true
      );
    } catch (error) {
      if (
        error instanceof OperationInterruptedError ||
        (error instanceof RuntimeControlProtocolError &&
          error.context.reason === 'activation-mismatch')
      ) {
        return false;
      }
      throw error;
    }
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
    runtime: RuntimeIdentity,
    next: (entry: TunnelCleanupEntry | undefined) => TunnelCleanupEntry,
    isInterrupted: () => boolean = () => false
  ): Promise<void> {
    await updatePortState(this.#host.storage, port, async (state, txn) => {
      await this.#assertStoredRuntime(txn, runtime, isInterrupted);
      return { cleanup: next(state.cleanup) };
    });
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
    const lifetime = await this.#host.currentLifetime?.getOrCreate();
    recovery.quickRun ??= {
      tunnelId: `quick-${randomId()}`,
      runId: createTunnelRunId()
    };
    const { tunnelId, runId } = recovery.quickRun;

    return await this.#host.runProvision(async (lease) => {
      let interrupted = false;
      let committedInfo: TunnelInfo | undefined;
      const hold = lease.retain(() => {
        interrupted = true;
      });
      const isInterrupted = () => interrupted;
      try {
        await this.#assertStoredRuntime(
          undefined,
          lease.runtime,
          isInterrupted
        );
        await this.#assertSandboxLifetime(lifetime, 'starting');
        const spawned = await this.#provisioner.provisionQuickTunnel(
          lease.tunnels,
          port,
          runId,
          tunnelId
        );
        await this.#assertSandboxLifetime(lifetime, 'process_ready');
        await updatePortState(this.#host.storage, port, async (_state, txn) => {
          await this.#assertStoredRuntime(txn, lease.runtime, isInterrupted);
          return {
            info: spawned,
            meta: {
              optionsHash: 'v1:quick',
              runtimeIdentityID: lease.runtime.id,
              runtimeIncarnationID: lease.runtime.runtimeIncarnationID,
              ...(lifetime && { sandboxLifetimeID: lifetime.id }),
              tunnelRunId: runId
            }
          };
        });
        committedInfo = spawned;
        await this.#assertStoredRuntime(
          undefined,
          lease.runtime,
          isInterrupted
        );
        await this.#assertSandboxLifetime(lifetime, 'committing');
        return spawned;
      } catch (error) {
        if (committedInfo) {
          await this.#invalidateCommittedPortIfUnchanged(
            port,
            committedInfo,
            lease.runtime,
            runId
          );
        }
        throw error;
      } finally {
        hold.release();
      }
    });
  }

  async #provisionNamedTunnel(
    port: number,
    name: string
  ): Promise<NamedTunnelInfo> {
    const lifetime = await this.#host.currentLifetime?.getOrCreate();

    return await this.#host.runProvision(async (lease) => {
      let interrupted = false;
      let committedInfo: TunnelInfo | undefined;
      let committedRunID: string | undefined;
      const hold = lease.retain(() => {
        interrupted = true;
      });
      const isInterrupted = () => interrupted;
      try {
        await this.#assertStoredRuntime(
          undefined,
          lease.runtime,
          isInterrupted
        );
        await this.#assertSandboxLifetime(lifetime, 'starting');
        await this.#resumePortCleanup(port);
        await this.#assertStoredRuntime(
          undefined,
          lease.runtime,
          isInterrupted
        );

        const prepared = await this.#provisioner.prepareNamedTunnel(
          port,
          name,
          {
            onIntentReady: (entry) =>
              this.#updatePortCleanup(
                port,
                lease.runtime,
                () => entry,
                isInterrupted
              ),
            onTunnelReady: (tunnelID) =>
              this.#updatePortCleanup(
                port,
                lease.runtime,
                (entry) =>
                  markCleanupTunnelReady(
                    this.#requireCleanupEntry(port, entry),
                    tunnelID
                  ),
                isInterrupted
              ),
            onDNSReady: (dnsRecordID) =>
              this.#updatePortCleanup(
                port,
                lease.runtime,
                (entry) =>
                  markCleanupDNSReady(
                    this.#requireCleanupEntry(port, entry),
                    dnsRecordID
                  ),
                isInterrupted
              )
          }
        );
        const cleanupEntry = createNamedTunnelCleanupEntry(
          prepared.info,
          prepared.meta
        );
        if (cleanupEntry) {
          await this.#updatePortCleanup(
            port,
            lease.runtime,
            () => cleanupEntry,
            isInterrupted
          );
        }
        await this.#assertSandboxLifetime(lifetime, 'cloudflare_ready');

        const tunnelRunID = createTunnelRunId();
        await this.#provisioner.startNamedTunnelRun(
          lease.tunnels,
          prepared,
          tunnelRunID
        );
        await this.#assertSandboxLifetime(lifetime, 'process_ready');

        await updatePortState(this.#host.storage, port, async (_state, txn) => {
          await this.#assertStoredRuntime(txn, lease.runtime, isInterrupted);
          return {
            info: prepared.info,
            meta: {
              ...prepared.meta,
              runtimeIdentityID: lease.runtime.id,
              runtimeIncarnationID: lease.runtime.runtimeIncarnationID,
              ...(lifetime && { sandboxLifetimeID: lifetime.id }),
              tunnelRunId: tunnelRunID
            },
            cleanup: undefined
          };
        });
        committedInfo = prepared.info;
        committedRunID = tunnelRunID;
        await this.#assertStoredRuntime(
          undefined,
          lease.runtime,
          isInterrupted
        );
        await this.#assertSandboxLifetime(lifetime, 'committing');
        return prepared.info;
      } catch (error) {
        if (committedInfo && committedRunID) {
          await this.#invalidateCommittedPortIfUnchanged(
            port,
            committedInfo,
            lease.runtime,
            committedRunID
          );
        }
        throw error;
      } finally {
        hold.release();
      }
    });
  }

  async #invalidateCommittedPortIfUnchanged(
    port: number,
    expectedInfo: TunnelInfo,
    runtime: RuntimeIdentity,
    runID: string
  ): Promise<void> {
    await updatePortState(this.#host.storage, port, (state) => {
      if (
        state.info?.id !== expectedInfo.id ||
        state.meta?.runtimeIdentityID !== runtime.id ||
        state.meta.runtimeIncarnationID !== runtime.runtimeIncarnationID ||
        state.meta.tunnelRunId !== runID
      ) {
        return undefined;
      }
      if (state.info.name) {
        return {
          info: undefined,
          meta: namedRespawnMeta(state.info, state.meta)
        };
      }
      return { info: undefined, meta: undefined };
    });
  }

  async #assertStoredRuntime(
    storage: Parameters<TunnelServiceHost['getStoredRuntime']>[0],
    expected: RuntimeIdentity,
    isInterrupted: () => boolean = () => false
  ): Promise<void> {
    if (isInterrupted()) throw new RuntimeIdentityInactiveError();
    const current = await this.#host.getStoredRuntime(storage);
    if (
      isInterrupted() ||
      !current ||
      current.id !== expected.id ||
      current.runtimeIncarnationID !== expected.runtimeIncarnationID
    ) {
      throw new RuntimeIdentityInactiveError();
    }
  }

  async #assertSandboxLifetime(
    lifetime: SandboxLifetime | undefined,
    phase: string
  ): Promise<void> {
    if (!lifetime || !this.#host.currentLifetime) return;
    try {
      await this.#host.currentLifetime.assertCurrent(lifetime);
    } catch (error) {
      if (error instanceof SandboxLifetimeChangedError) {
        throw createTunnelInterruptedError({
          reason: 'sandbox_lifetime_changed',
          phase,
          admitted: true,
          retryable: false,
          message:
            'Tunnel operation was interrupted by a sandbox lifetime change'
        });
      }
      throw error;
    }
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
          const owningRuntime = tunnelOwningRuntime(current.meta);
          if (owningRuntime && current.meta?.tunnelRunId) {
            const tunnelRunId = current.meta.tunnelRunId;
            await this.#host.runExisting(
              owningRuntime,
              'tunnel.destroy',
              (tunnels) =>
                tunnels.stopTunnelRun({
                  tunnelId: existing.id,
                  runId: tunnelRunId
                })
            );
          }
        } catch (error) {
          if (
            isTunnelNotFoundError(error) ||
            error instanceof OperationInterruptedError ||
            isRuntimeActivationMismatch(error)
          ) {
            // The owning runtime is already absent — continue durable cleanup.
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
    const { map, meta, runtime } = await this.#host.storage.transaction(
      async (txn) => {
        const [map, meta, runtime] = await Promise.all([
          readMap(txn),
          readMetaMap(txn),
          this.#host.getStoredRuntime(txn)
        ]);
        return { map, meta, runtime };
      }
    );
    return Object.entries(map)
      .filter(
        ([port]) =>
          !meta[port]?.needsRespawn &&
          tunnelMetaOwnsRuntime(meta[port], runtime)
      )
      .map(([, info]) => info);
  }

  async onTunnelExit(
    id: string,
    port: number,
    exitCode: number | null,
    tunnelRunId: string,
    runtime: RuntimeIdentity,
    isSessionCurrent: () => boolean
  ): Promise<void> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      await this.#withPortLock(port, async () => {
        await updatePortState(this.#host.storage, port, async (state, txn) => {
          const existing = state.info;
          const meta = state.meta;
          const activeRuntime = await this.#host.getStoredRuntime(txn);
          if (!isSessionCurrent() || existing?.id !== id) return undefined;
          if (
            !activeRuntime ||
            activeRuntime.id !== runtime.id ||
            activeRuntime.runtimeIncarnationID !==
              runtime.runtimeIncarnationID ||
            meta?.runtimeIdentityID !== runtime.id ||
            meta.runtimeIncarnationID !== runtime.runtimeIncarnationID ||
            meta.tunnelRunId !== tunnelRunId
          ) {
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
      const owningRuntime = tunnelOwningRuntime(meta[String(port)]);
      if (!owningRuntime) continue;
      try {
        await this.#host.runExisting(
          owningRuntime,
          'tunnel.destroy',
          (tunnels) => tunnels.stopTunnelRun({ tunnelId: info.id, runId })
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
