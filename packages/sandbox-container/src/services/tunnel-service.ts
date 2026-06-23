/**
 * TunnelService - container-side orchestration for cloudflared quick tunnels.
 *
 * Owns the in-memory registry of tunnels running inside this container and
 * delegates the actual subprocess supervision to `TunnelManager`. No
 * Cloudflare API calls happen here; quick tunnels need no credentials.
 *
 * The SDK mints all tunnel ids and passes them in so the SDK can store the
 * id without waiting for the create round-trip to resolve.
 */

import type {
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  Logger,
  SandboxControlCallback,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelInfo,
  TunnelRunSnapshot
} from '@repo/shared';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';
import {
  CloudflaredNotFoundError,
  TunnelManager
} from '../managers/tunnel-manager';

export interface RunTunnelOptions {
  /** Override the readiness timeout. Forwarded to TunnelManager. */
  readyTimeoutMs?: number;
  /** Override the SIGTERM→SIGKILL grace period. Forwarded to TunnelManager. */
  stopGraceMs?: number;
}

interface TunnelRecord {
  info: TunnelInfo;
  manager: TunnelManager;
}

/** Runtime-run registry entry for ensureTunnelRun/stopTunnelRun paths. */
interface TunnelRunRecord {
  request: EnsureTunnelRunRequest;
  snapshot: TunnelRunSnapshot;
  manager: TunnelManager;
}

export class TunnelService {
  private readonly tunnels = new Map<string, TunnelRecord>();
  /** Keyed by `runId`. Separate from legacy `tunnels` so list() behavior is unchanged. */
  private readonly tunnelRuns = new Map<string, TunnelRunRecord>();

  /**
   * @param logger Child logger for tunnel-service log lines.
   * @param getControlCallback Optional accessor returning the DO-side
   * control callback exposed over the capnweb session's remote main.
   * Resolved fresh on every cloudflared exit, returning `null` when the
   * session is not bound yet (legacy callers, tests, or
   * pre-WS-upgrade window).
   */
  constructor(
    private readonly logger: Logger,
    private readonly getControlCallback: () => SandboxControlCallback | null = () =>
      null
  ) {}

  async runQuickTunnel(
    id: string,
    port: number,
    options?: RunTunnelOptions
  ): Promise<ServiceResult<TunnelInfo>> {
    if (this.tunnels.has(id)) {
      return serviceError({
        message: `Tunnel ${id} is already running`,
        code: 'TUNNEL_ALREADY_RUNNING',
        details: { tunnelId: id }
      });
    }

    const manager = new TunnelManager({
      port,
      logger: this.logger,
      readyTimeoutMs: options?.readyTimeoutMs,
      stopGraceMs: options?.stopGraceMs,
      onExit: (code) => {
        // Drop our in-memory registry first so list() / destroyAll()
        // don't see a phantom record while we await the DO callback.
        this.tunnels.delete(id);
        const cb = this.getControlCallback();
        if (!cb) return;
        // Fire-and-forget the DO notification. Errors are swallowed
        // so a misbehaving DO can't crash the manager's exit handler.
        cb.onTunnelExit(id, port, code).catch((err) => {
          this.logger.warn('onTunnelExit RPC failed', {
            id,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    });

    try {
      const { url } = await manager.start();
      if (!url) {
        // Should not happen: quick mode always parses a trycloudflare URL
        // before resolving. Defensive guard so the type narrowing is clear.
        throw new Error('Quick tunnel did not produce a public URL');
      }
      const hostname = new URL(url).hostname;
      const info: TunnelInfo = {
        id,
        port,
        url,
        hostname,
        createdAt: new Date().toISOString()
      };
      this.tunnels.set(id, { info, manager });
      this.logger.info('Quick tunnel running', { id, port, url });
      return serviceSuccess(info);
    } catch (err) {
      await manager.stop().catch(() => {});
      if (err instanceof CloudflaredNotFoundError) {
        return serviceError({
          message: err.message,
          code: 'CLOUDFLARED_NOT_FOUND',
          details: { tunnelId: id, port, binary: err.binary }
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return serviceError({
        message: `Failed to run quick tunnel: ${message}`,
        code: 'TUNNEL_START_ERROR',
        details: { tunnelId: id, port }
      });
    }
  }

  /**
   * Run a named cloudflared tunnel backed by a Cloudflare-issued `--token`.
   *
   * The SDK is the source of truth for the hostname this tunnel maps to:
   * the container only knows the local port and the opaque token. The
   * returned `TunnelInfo` therefore carries empty `url`/`hostname` fields,
   * which the SDK enriches with the values from the Cloudflare API before
   * returning to user code.
   *
   * The `token` is never logged or persisted in the returned record.
   */
  async runNamedTunnel(
    id: string,
    token: string,
    port: number,
    options?: RunTunnelOptions
  ): Promise<ServiceResult<TunnelInfo>> {
    if (this.tunnels.has(id)) {
      return serviceError({
        message: `Tunnel ${id} is already running`,
        code: 'TUNNEL_ALREADY_RUNNING',
        details: { tunnelId: id }
      });
    }

    const manager = new TunnelManager({
      port,
      token,
      logger: this.logger,
      readyTimeoutMs: options?.readyTimeoutMs,
      stopGraceMs: options?.stopGraceMs,
      onExit: (code) => {
        this.tunnels.delete(id);
        const cb = this.getControlCallback();
        if (!cb) return;
        cb.onTunnelExit(id, port, code).catch((err) => {
          this.logger.warn('onTunnelExit RPC failed', {
            id,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    });

    try {
      await manager.start();
      const info: TunnelInfo = {
        id,
        port,
        // The SDK fills these in from the Cloudflare API. The container
        // does not know the hostname for a token-driven tunnel.
        url: '',
        hostname: '',
        createdAt: new Date().toISOString()
      };
      this.tunnels.set(id, { info, manager });
      this.logger.info('Named tunnel running', { id, port });
      return serviceSuccess(info);
    } catch (err) {
      await manager.stop().catch(() => {});
      if (err instanceof CloudflaredNotFoundError) {
        return serviceError({
          message: err.message,
          code: 'CLOUDFLARED_NOT_FOUND',
          details: { tunnelId: id, port, binary: err.binary }
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return serviceError({
        message: `Failed to run named tunnel: ${message}`,
        code: 'TUNNEL_START_ERROR',
        details: { tunnelId: id, port }
      });
    }
  }

  /**
   * Start or replay a cloudflared run identified by `(tunnelId, runId)`.
   * Idempotent: same request replays with `started: false`. Conflict:
   * different params for same runId, or different active run on same
   * port/tunnelId, returns `TUNNEL_RUN_CONFLICT`.
   */
  async ensureTunnelRun(
    request: EnsureTunnelRunRequest
  ): Promise<ServiceResult<EnsureTunnelRunResult>> {
    const { tunnelId, runId, mode, port } = request;

    // Idempotent replay: same runId already running.
    const existing = this.tunnelRuns.get(runId);
    if (existing) {
      const prev = existing.request;
      if (
        prev.tunnelId !== tunnelId ||
        prev.mode !== mode ||
        prev.port !== port
      ) {
        return serviceError({
          message: `Run ${runId} already active with different params`,
          code: 'TUNNEL_RUN_CONFLICT',
          details: { runId, tunnelId, port }
        });
      }
      return serviceSuccess({ run: existing.snapshot, started: false });
    }

    // Conflict: different runId on the same port.
    for (const rec of this.tunnelRuns.values()) {
      if (rec.request.port === port) {
        return serviceError({
          message: `Port ${port} already active under run ${rec.request.runId}`,
          code: 'TUNNEL_RUN_CONFLICT',
          details: { runId, port, activeRunId: rec.request.runId }
        });
      }
      if (rec.request.tunnelId === tunnelId) {
        return serviceError({
          message: `Tunnel ${tunnelId} already active under run ${rec.request.runId}`,
          code: 'TUNNEL_RUN_CONFLICT',
          details: { tunnelId, runId, activeRunId: rec.request.runId }
        });
      }
    }

    const token = mode === 'named' ? request.token : undefined;
    const manager = new TunnelManager({
      port,
      token,
      logger: this.logger,
      onExit: (code) => {
        this.tunnelRuns.delete(runId);
        const cb = this.getControlCallback();
        if (!cb) return;
        cb.onTunnelExit(tunnelId, port, code, runId).catch((err) => {
          this.logger.warn('onTunnelExit RPC failed (runtime-run)', {
            tunnelId,
            runId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    });

    try {
      const startResult = await manager.start();
      const snapshot: TunnelRunSnapshot = {
        tunnelId,
        runId,
        mode,
        port,
        startedAt: new Date().toISOString(),
        ...(mode === 'quick' && startResult.url
          ? {
              url: startResult.url,
              hostname: new URL(startResult.url).hostname
            }
          : {})
      };
      this.tunnelRuns.set(runId, { request, snapshot, manager });
      this.logger.info('Tunnel run started', { tunnelId, runId, mode, port });
      return serviceSuccess({ run: snapshot, started: true });
    } catch (err) {
      await manager.stop().catch(() => {});
      if (err instanceof CloudflaredNotFoundError) {
        return serviceError({
          message: err.message,
          code: 'CLOUDFLARED_NOT_FOUND',
          details: { tunnelId, runId, port, binary: err.binary }
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return serviceError({
        message: `Failed to start tunnel run: ${message}`,
        code: 'TUNNEL_START_ERROR',
        details: { tunnelId, runId, port }
      });
    }
  }

  /**
   * Stop the cloudflared process identified by the exact `(tunnelId, runId)` pair.
   * Returns `{ stopped: true }` when found and stopped; `{ stopped: false }` when
   * no matching run is active. A non-matching runId for a known tunnelId also
   * returns `{ stopped: false }`; exact run identity is required for stop.
   */
  async stopTunnelRun(
    request: StopTunnelRunRequest
  ): Promise<ServiceResult<StopTunnelRunResult>> {
    const { tunnelId, runId } = request;
    const rec = this.tunnelRuns.get(runId);
    if (!rec || rec.request.tunnelId !== tunnelId) {
      return serviceSuccess({ stopped: false });
    }
    try {
      await rec.manager.stop();
    } finally {
      this.tunnelRuns.delete(runId);
    }
    this.logger.info('Tunnel run stopped', { tunnelId, runId });
    return serviceSuccess({ stopped: true });
  }

  async destroyTunnel(id: string): Promise<ServiceResult<void>> {
    const record = this.tunnels.get(id);
    if (!record) {
      return serviceError({
        message: `Tunnel ${id} is not running`,
        code: 'TUNNEL_NOT_FOUND',
        details: { tunnelId: id }
      });
    }
    try {
      await record.manager.stop();
    } finally {
      this.tunnels.delete(id);
    }
    this.logger.info('Tunnel destroyed', { id });
    return { success: true };
  }

  list(): TunnelInfo[] {
    return Array.from(this.tunnels.values()).map((r) => r.info);
  }

  /** Stop every tunnel. Called on container shutdown. */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.tunnels.keys());
    await Promise.all(ids.map((id) => this.destroyTunnel(id)));
  }
}
