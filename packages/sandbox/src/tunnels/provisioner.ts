import type {
  NamedTunnelInfo,
  QuickTunnelInfo,
  SandboxTunnelsAPI
} from '@repo/shared';
import {
  createTunnel,
  findTunnelByName,
  getTunnelToken,
  getZoneName,
  upsertCNAME
} from './cloudflare-api';
import { computeOptionsHash, type TunnelMetaEntry } from './storage';

interface TunnelsRPCClient {
  tunnels: SandboxTunnelsAPI;
}

export interface TunnelProvisionerHost {
  client: TunnelsRPCClient;
  sandboxId?: string;
  getNamedTunnelConfig?: () => Promise<{
    token: string;
    accountId: string;
    zoneId: string;
  }>;
  fetcher?: typeof fetch;
}

export interface PreparedNamedTunnel {
  tunnelId: string;
  tunnelToken: string;
  info: NamedTunnelInfo;
  meta: TunnelMetaEntry;
}

/** 8-char hex id derived from `crypto.getRandomValues`. Unique per sandbox. */
function shortId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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

function isTunnelAlreadyRunningError(error: unknown): boolean {
  return hasErrorCode(error, 'TUNNEL_ALREADY_RUNNING');
}

export class TunnelProvisioner {
  readonly #host: TunnelProvisionerHost;
  #zoneNamePromise: Promise<string> | null = null;

  constructor(host: TunnelProvisionerHost) {
    this.#host = host;
  }

  async provisionQuickTunnel(
    port: number,
    tunnelRunId: string
  ): Promise<QuickTunnelInfo> {
    const MAX_ID_RETRIES = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt += 1) {
      const id = `quick-${shortId()}`;
      try {
        return (await this.#host.client.tunnels.runQuickTunnel(
          id,
          port,
          tunnelRunId
        )) as QuickTunnelInfo;
      } catch (err) {
        if (!isTunnelAlreadyRunningError(err)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new Error('Failed to mint a unique quick-tunnel id');
  }

  async prepareNamedTunnel(
    port: number,
    name: string
  ): Promise<PreparedNamedTunnel> {
    if (!this.#host.sandboxId) {
      throw new Error(
        'Named tunnels require host.sandboxId on the tunnel service.'
      );
    }
    if (!this.#host.getNamedTunnelConfig) {
      throw new Error(
        'Named tunnels require host.getNamedTunnelConfig on the tunnel service.'
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

    let tunnelId: string;
    let tunnelToken: string;
    const existingTunnel = await findTunnelByName({
      token: config.token,
      accountId: config.accountId,
      tunnelName,
      expectedSandboxId: sandboxId,
      fetcher: this.#host.fetcher
    });
    if (existingTunnel) {
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

    const dnsResult = await upsertCNAME({
      token: config.token,
      zoneId: config.zoneId,
      hostname,
      cnameTarget: `${tunnelId}.cfargotunnel.com`,
      comment: `sandbox-${sandboxId}`,
      sandboxId,
      fetcher: this.#host.fetcher
    });

    const info: NamedTunnelInfo = {
      id: tunnelId,
      port,
      name,
      hostname,
      url: `https://${hostname}`,
      createdAt: new Date().toISOString()
    };

    return {
      tunnelId,
      tunnelToken,
      info,
      meta: {
        optionsHash: computeOptionsHash({ name }),
        dnsRecordId: dnsResult.recordId,
        accountId: config.accountId,
        zoneId: config.zoneId,
        tunnelId,
        name,
        hostname
      }
    };
  }

  async runNamedTunnel(
    prepared: PreparedNamedTunnel,
    tunnelRunId: string
  ): Promise<void> {
    await this.#host.client.tunnels.runNamedTunnel(
      prepared.tunnelId,
      prepared.tunnelToken,
      prepared.info.port,
      tunnelRunId
    );
  }

  clearCachedZoneName(): void {
    this.#zoneNamePromise = null;
  }

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
      pending.catch(() => {
        if (this.#zoneNamePromise === pending) {
          this.#zoneNamePromise = null;
        }
      });
    }
    return this.#zoneNamePromise;
  }
}
