/**
 * TunnelService - container-side orchestration for cloudflared tunnels.
 *
 * The container only knows how to *run* a tunnel. Cloudflare API calls
 * (creating named tunnels, DNS records) happen DO-side; the container
 * never sees credentials or hostnames for token tunnels.
 *
 * The DO mints all tunnel ids and passes them in. For quick tunnels the
 * container parses the assigned `*.trycloudflare.com` URL out of
 * cloudflared's banner and returns it; for token tunnels the container
 * has no idea what hostname the edge will bind, so it returns a record
 * without `url` / `hostname` and the DO fills those in.
 */

import type { Logger } from '@repo/shared';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';
import { TunnelManager } from '../managers/tunnel-manager';

export type TunnelMode = 'quick' | 'token';

export interface ContainerTunnelInfo {
  id: string;
  mode: TunnelMode;
  port: number;
  /** Set for quick tunnels only. */
  url?: string;
  /** Set for quick tunnels only. */
  hostname?: string;
  /** ISO-8601 wall-clock creation time. */
  createdAt: string;
}

interface TunnelRecord {
  info: ContainerTunnelInfo;
  manager: TunnelManager;
}

export class TunnelService {
  private readonly tunnels = new Map<string, TunnelRecord>();

  constructor(private readonly logger: Logger) {}

  async runQuickTunnel(
    id: string,
    port: number
  ): Promise<ServiceResult<ContainerTunnelInfo>> {
    if (this.tunnels.has(id)) {
      return serviceError({
        message: `Tunnel ${id} is already running`,
        code: 'TUNNEL_ALREADY_RUNNING',
        details: { tunnelId: id }
      });
    }

    const manager = new TunnelManager({
      mode: 'quick',
      port,
      logger: this.logger
    });

    try {
      const { url } = await manager.start();
      if (!url) {
        throw new Error('Quick tunnel did not produce a URL');
      }
      const hostname = new URL(url).hostname;
      const info: ContainerTunnelInfo = {
        id,
        mode: 'quick',
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
      const message = err instanceof Error ? err.message : String(err);
      return serviceError({
        message: `Failed to run quick tunnel: ${message}`,
        code: 'TUNNEL_START_ERROR',
        details: { tunnelId: id, port }
      });
    }
  }

  async runTokenTunnel(
    id: string,
    token: string,
    port: number
  ): Promise<ServiceResult<ContainerTunnelInfo>> {
    if (this.tunnels.has(id)) {
      return serviceError({
        message: `Tunnel ${id} is already running`,
        code: 'TUNNEL_ALREADY_RUNNING',
        details: { tunnelId: id }
      });
    }

    const manager = new TunnelManager({
      mode: 'token',
      port,
      token,
      logger: this.logger
    });

    try {
      await manager.start();
      const info: ContainerTunnelInfo = {
        id,
        mode: 'token',
        port,
        createdAt: new Date().toISOString()
      };
      this.tunnels.set(id, { info, manager });
      this.logger.info('Token tunnel running', { id, port });
      return serviceSuccess(info);
    } catch (err) {
      await manager.stop().catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      return serviceError({
        message: `Failed to run token tunnel: ${message}`,
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
    return serviceSuccess(undefined as void);
  }

  list(): ContainerTunnelInfo[] {
    return Array.from(this.tunnels.values()).map((r) => r.info);
  }

  /** Stop every tunnel. Called on container shutdown. */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.tunnels.keys());
    await Promise.all(ids.map((id) => this.destroyTunnel(id)));
  }
}
