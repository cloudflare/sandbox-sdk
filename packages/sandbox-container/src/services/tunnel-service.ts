/**
 * TunnelService - container-side orchestration for cloudflared tunnel runs.
 *
 * Owns the runtime-local registry of tunnel runs inside this container and
 * delegates subprocess supervision to `TunnelManager`. Cloudflare API calls
 * happen in the SDK; the container receives DO-issued tunnel/run identities,
 * the local port, and for named tunnels an opaque token.
 */

import type {
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  Logger,
  SandboxControlCallback,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelRunExitEvent,
  TunnelRunSnapshot
} from '@repo/shared';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';
import {
  CloudflaredNotFoundError,
  TunnelManager
} from '../managers/tunnel-manager';

interface TunnelRecord {
  manager: TunnelManager;
  request: EnsureTunnelRunRequest;
  result: Promise<ServiceResult<EnsureTunnelRunResult>>;
}

function tunnelRunExitEvent(
  request: EnsureTunnelRunRequest,
  exitCode: number | null
): TunnelRunExitEvent {
  return {
    tunnelId: request.tunnelId,
    runId: request.runId,
    mode: request.mode,
    port: request.port,
    exitCode
  };
}

function tunnelRunRequestsMatch(
  left: EnsureTunnelRunRequest,
  right: EnsureTunnelRunRequest
): boolean {
  if (
    left.mode !== right.mode ||
    left.tunnelId !== right.tunnelId ||
    left.runId !== right.runId ||
    left.port !== right.port ||
    left.readyTimeoutMs !== right.readyTimeoutMs ||
    left.stopGraceMs !== right.stopGraceMs
  ) {
    return false;
  }

  if (left.mode === 'named' || right.mode === 'named') {
    return (
      left.mode === 'named' &&
      right.mode === 'named' &&
      left.cloudflaredToken === right.cloudflaredToken
    );
  }

  return true;
}

export class TunnelService {
  private readonly runs = new Map<string, TunnelRecord>();
  private readonly runsByTunnelId = new Map<string, TunnelRecord>();
  private readonly runsByPort = new Map<number, TunnelRecord>();

  /**
   * @param logger Child logger for tunnel-service log lines.
   * @param getControlCallback Optional accessor returning the DO-side
   * control callback exposed over the capnweb session's remote main.
   * Resolved fresh on every cloudflared exit, returning `null` when the
   * session is not bound yet (tests or pre-WS-upgrade window).
   */
  constructor(
    private readonly logger: Logger,
    private readonly getControlCallback: () => SandboxControlCallback | null = () =>
      null
  ) {}

  async ensureTunnelRun(
    request: EnsureTunnelRunRequest
  ): Promise<ServiceResult<EnsureTunnelRunResult>> {
    const existingRun = this.runs.get(request.runId);
    if (existingRun) {
      if (!tunnelRunRequestsMatch(existingRun.request, request)) {
        return serviceError({
          message: `Tunnel run ${request.runId} is already running with different parameters`,
          code: 'TUNNEL_RUN_CONFLICT',
          details: { tunnelId: request.tunnelId, runId: request.runId }
        });
      }
      const result = await existingRun.result;
      if (!result.success) return result;
      return serviceSuccess({ run: result.data.run, started: false });
    }

    const existingTunnel = this.runsByTunnelId.get(request.tunnelId);
    if (existingTunnel) {
      return serviceError({
        message: `Tunnel ${request.tunnelId} already has an active run`,
        code: 'TUNNEL_RUN_CONFLICT',
        details: { tunnelId: request.tunnelId, runId: request.runId }
      });
    }

    const existingPort = this.runsByPort.get(request.port);
    if (existingPort) {
      return serviceError({
        message: `Port ${request.port} already has an active tunnel run`,
        code: 'TUNNEL_RUN_CONFLICT',
        details: {
          tunnelId: request.tunnelId,
          runId: request.runId,
          port: request.port,
          activeRunId: existingPort.request.runId
        }
      });
    }

    const manager = new TunnelManager({
      port: request.port,
      token: request.mode === 'named' ? request.cloudflaredToken : undefined,
      logger: this.logger,
      readyTimeoutMs: request.readyTimeoutMs,
      stopGraceMs: request.stopGraceMs,
      onExit: (code) => {
        this.#deleteRun(request.tunnelId, request.runId, request.port);
        const cb = this.getControlCallback();
        if (!cb) return;
        cb.onTunnelRunExit(tunnelRunExitEvent(request, code)).catch((err) => {
          this.logger.warn('onTunnelRunExit RPC failed', {
            id: request.tunnelId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    });

    const result = Promise.resolve().then(() =>
      this.#startTunnelRun(request, manager)
    );
    const record: TunnelRecord = {
      manager,
      request,
      result
    };
    this.runs.set(request.runId, record);
    this.runsByTunnelId.set(request.tunnelId, record);
    this.runsByPort.set(request.port, record);
    return await record.result;
  }

  async #startTunnelRun(
    request: EnsureTunnelRunRequest,
    manager: TunnelManager
  ): Promise<ServiceResult<EnsureTunnelRunResult>> {
    try {
      const { url } = await manager.start();
      const run = this.#createSnapshot(request, url);
      this.logger.info('Tunnel run ready', {
        mode: request.mode,
        tunnelId: request.tunnelId,
        runId: request.runId,
        port: request.port
      });
      return serviceSuccess({ run, started: true });
    } catch (err) {
      this.#deleteRun(request.tunnelId, request.runId, request.port);
      await manager.stop().catch(() => {});
      if (err instanceof CloudflaredNotFoundError) {
        return serviceError({
          message: err.message,
          code: 'CLOUDFLARED_NOT_FOUND',
          details: {
            tunnelId: request.tunnelId,
            runId: request.runId,
            port: request.port,
            binary: err.binary
          }
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return serviceError({
        message: `Failed to run tunnel: ${message}`,
        code: 'TUNNEL_START_ERROR',
        details: {
          tunnelId: request.tunnelId,
          runId: request.runId,
          port: request.port
        }
      });
    }
  }

  async stopTunnelRun(
    request: StopTunnelRunRequest
  ): Promise<ServiceResult<StopTunnelRunResult>> {
    const record = this.runs.get(request.runId);

    if (!record || record.request.tunnelId !== request.tunnelId) {
      return serviceSuccess({ stopped: false });
    }

    try {
      await record.manager.stop();
    } finally {
      this.#deleteRun(
        record.request.tunnelId,
        record.request.runId,
        record.request.port
      );
    }
    this.logger.info('Tunnel run stopped', {
      tunnelId: record.request.tunnelId,
      runId: record.request.runId,
      port: record.request.port
    });
    return serviceSuccess({ stopped: true });
  }

  /** Stop every runtime-local tunnel run. Called on container shutdown. */
  async destroyAll(): Promise<void> {
    const runs = Array.from(this.runs.values());
    await Promise.all(
      runs.map((record) =>
        this.stopTunnelRun({
          tunnelId: record.request.tunnelId,
          runId: record.request.runId
        })
      )
    );
  }

  #createSnapshot(
    request: EnsureTunnelRunRequest,
    url: string | undefined
  ): TunnelRunSnapshot {
    const startedAt = new Date().toISOString();
    if (request.mode === 'quick') {
      if (!url) {
        throw new Error('Quick tunnel did not produce a public URL');
      }
      return {
        mode: 'quick',
        tunnelId: request.tunnelId,
        runId: request.runId,
        port: request.port,
        url,
        hostname: new URL(url).hostname,
        startedAt
      };
    }
    return {
      mode: 'named',
      tunnelId: request.tunnelId,
      runId: request.runId,
      port: request.port,
      startedAt
    };
  }

  #deleteRun(tunnelId: string, runId: string, port: number): void {
    this.runs.delete(runId);
    this.runsByTunnelId.delete(tunnelId);
    this.runsByPort.delete(port);
  }
}
