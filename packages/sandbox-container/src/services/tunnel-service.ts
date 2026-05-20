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

import type { Logger, SandboxControlCallback, TunnelInfo } from '@repo/shared';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';
import {
  CloudflaredNotFoundError,
  TunnelManager
} from '../managers/tunnel-manager';

export interface RunQuickTunnelOptions {
  /** Override the readiness timeout. Forwarded to TunnelManager. */
  readyTimeoutMs?: number;
  /** Override the SIGTERM→SIGKILL grace period. Forwarded to TunnelManager. */
  stopGraceMs?: number;
}

interface TunnelRecord {
  info: TunnelInfo;
  manager: TunnelManager;
}

export class TunnelService {
  private readonly tunnels = new Map<string, TunnelRecord>();

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
    options?: RunQuickTunnelOptions
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
    options?: RunQuickTunnelOptions
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
      mode: 'named',
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
