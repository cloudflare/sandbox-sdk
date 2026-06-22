import type {
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  NamedTunnelInfo,
  QuickTunnelInfo,
  SandboxTunnelsAPI
} from '@repo/shared';
import { RPCTransportError } from '../errors';
import {
  createTunnel,
  findTunnelByName,
  getTunnelToken,
  getZoneName,
  upsertCNAME
} from './cloudflare-api';
import {
  computeOptionsHash,
  createNamedTunnelResourceIntent,
  type TunnelCleanupEntry,
  type TunnelMetaEntry
} from './storage';

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

export interface NamedTunnelPreparationHooks {
  onIntentReady?: (entry: TunnelCleanupEntry) => Promise<void>;
  onTunnelReady?: (tunnelId: string) => Promise<void>;
  onDNSReady?: (dnsRecordId: string) => Promise<void>;
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

// Replays use the same request so container runId idempotency can resolve
// an ambiguous transport failure.
const TUNNEL_RUN_TRANSPORT_REPLAY_ATTEMPTS = 1;

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
        const result = await this.#ensureTunnelRun({
          mode: 'quick',
          tunnelId: id,
          runId: tunnelRunId,
          port
        });
        if (result.run.mode !== 'quick') {
          throw new Error('Container returned a non-quick tunnel run');
        }
        return {
          id: result.run.tunnelId,
          port: result.run.port,
          url: result.run.url,
          hostname: result.run.hostname,
          createdAt: result.run.startedAt
        };
      } catch (err) {
        if (!isTunnelAlreadyRunningError(err)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new Error('Failed to mint a unique quick-tunnel id');
  }

  async prepareNamedTunnel(
    port: number,
    name: string,
    hooks: NamedTunnelPreparationHooks = {}
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
    await hooks.onIntentReady?.(
      createNamedTunnelResourceIntent({
        port,
        name,
        hostname,
        tunnelName,
        sandboxId,
        accountId: config.accountId,
        zoneId: config.zoneId
      })
    );

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
    await hooks.onTunnelReady?.(tunnelId);

    const dnsResult = await upsertCNAME({
      token: config.token,
      zoneId: config.zoneId,
      hostname,
      cnameTarget: `${tunnelId}.cfargotunnel.com`,
      comment: `sandbox-${sandboxId}`,
      sandboxId,
      fetcher: this.#host.fetcher
    });
    await hooks.onDNSReady?.(dnsResult.recordId);

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

  async startNamedTunnelRun(
    prepared: PreparedNamedTunnel,
    tunnelRunId: string
  ): Promise<void> {
    const result = await this.#ensureTunnelRun({
      mode: 'named',
      tunnelId: prepared.tunnelId,
      runId: tunnelRunId,
      port: prepared.info.port,
      cloudflaredToken: prepared.tunnelToken
    });
    if (result.run.mode !== 'named') {
      throw new Error('Container returned a non-named tunnel run');
    }
  }

  clearCachedZoneName(): void {
    this.#zoneNamePromise = null;
  }

  async #ensureTunnelRun(
    request: EnsureTunnelRunRequest
  ): Promise<EnsureTunnelRunResult> {
    let replays = 0;
    while (true) {
      try {
        return await this.#host.client.tunnels.ensureTunnelRun(request);
      } catch (error) {
        if (
          !(error instanceof RPCTransportError) ||
          replays >= TUNNEL_RUN_TRANSPORT_REPLAY_ATTEMPTS
        ) {
          throw error;
        }
        replays += 1;
      }
    }
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
