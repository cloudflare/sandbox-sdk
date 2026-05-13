/**
 * Tunnels namespace handler. Created once per Sandbox DO instance via
 * `createTunnelsHandler(host)` and exposed as `sandbox.tunnels`.
 */

import type { Logger, SandboxTunnelsAPI, TunnelInfo } from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import { SandboxSecurityError, validatePort } from '../security';

/** Subset of the RPC client this handler depends on. */
interface TunnelsRPCClient {
  tunnels: SandboxTunnelsAPI;
}

/** Subset of the Sandbox DO the handler reads from. */
export interface TunnelsHandlerHost {
  client: TunnelsRPCClient;
  logger: Logger;
}

export interface TunnelsHandler {
  create(port: number): Promise<TunnelInfo>;
  list(): Promise<TunnelInfo[]>;
  destroy(idOrInfo: string | TunnelInfo): Promise<void>;
}

function validateTunnelPort(port: number): void {
  if (!validatePort(port)) {
    throw new SandboxSecurityError(
      `Invalid port number: ${port}. Must be 1024-65535, excluding reserved ports.`
    );
  }
}

/** 8-char hex id derived from `crypto.getRandomValues`. */
function shortId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function createTunnelsHandler(host: TunnelsHandlerHost): TunnelsHandler {
  async function create(port: number): Promise<TunnelInfo> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      validateTunnelPort(port);

      const id = `quick-${shortId()}`;
      const info = await host.client.tunnels.runQuickTunnel(id, port);
      outcome = 'success';
      return info;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(host.logger, {
        event: 'tunnel.create',
        outcome,
        port,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  async function destroy(idOrInfo: string | TunnelInfo): Promise<void> {
    const id = typeof idOrInfo === 'string' ? idOrInfo : idOrInfo.id;
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      await host.client.tunnels.destroyTunnel(id);
      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(host.logger, {
        event: 'tunnel.destroy',
        outcome,
        tunnelId: id,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  async function list(): Promise<TunnelInfo[]> {
    return host.client.tunnels.listTunnels();
  }

  return { create, list, destroy };
}
