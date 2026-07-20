import type {
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
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
import { randomId } from './random-id';
import {
  computeOptionsHash,
  createNamedTunnelResourceIntent,
  type TunnelCleanupEntry,
  type TunnelMetaEntry
} from './storage';

export interface TunnelProvisionerHost {
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

function createQuickTunnelId(): string {
  return `quick-${randomId()}`;
}

export class TunnelProvisioner {
  readonly #host: TunnelProvisionerHost;
  #zoneNamePromise: Promise<string> | null = null;

  constructor(host: TunnelProvisionerHost) {
    this.#host = host;
  }

  async provisionQuickTunnel(
    tunnels: SandboxTunnelsAPI,
    port: number,
    tunnelRunId: string,
    tunnelId = createQuickTunnelId()
  ): Promise<QuickTunnelInfo> {
    const result = await this.#ensureTunnelRun(tunnels, {
      mode: 'quick',
      tunnelId,
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
    tunnels: SandboxTunnelsAPI,
    prepared: PreparedNamedTunnel,
    tunnelRunId: string
  ): Promise<void> {
    const result = await this.#ensureTunnelRun(tunnels, {
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
    tunnels: SandboxTunnelsAPI,
    request: EnsureTunnelRunRequest
  ): Promise<EnsureTunnelRunResult> {
    return await tunnels.ensureTunnelRun(request);
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
