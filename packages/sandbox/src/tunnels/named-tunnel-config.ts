import { getEnvString } from '@repo/shared';
import { resolveAccountId, resolveZoneId } from './credentials';

export interface NamedTunnelConfig {
  token: string;
  accountId: string;
  zoneId: string;
}

export interface NamedTunnelConfigResolverOptions {
  getEnv: () => unknown;
  fetcher?: typeof fetch;
}

function asEnvRecord(env: unknown): Record<string, unknown> {
  return env && typeof env === 'object' ? (env as Record<string, unknown>) : {};
}

export class NamedTunnelConfigResolver {
  readonly #getEnv: () => unknown;
  readonly #fetcher?: typeof fetch;
  #accountIdPromise: Promise<string> | null = null;
  #zoneIdPromise: Promise<string> | null = null;

  constructor(options: NamedTunnelConfigResolverOptions) {
    this.#getEnv = options.getEnv;
    this.#fetcher = options.fetcher;
  }

  async getConfig(): Promise<NamedTunnelConfig> {
    const env = this.#env();
    const token = getEnvString(env, 'CLOUDFLARE_API_TOKEN');
    if (!token) {
      throw new Error(
        'Named tunnels require CLOUDFLARE_API_TOKEN. ' +
          'Set it as a secret in your wrangler.jsonc.'
      );
    }

    const accountId = await this.#getAccountId();
    const zoneId = await this.#getZoneId(token, accountId);
    return { token, accountId, zoneId };
  }

  #env(): Record<string, unknown> {
    return asEnvRecord(this.#getEnv());
  }

  #getAccountId(): Promise<string> {
    if (!this.#accountIdPromise) {
      const pending = resolveAccountId(this.#env(), {
        overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID',
        fetcher: this.#fetcher
      });
      this.#accountIdPromise = pending;
      pending.catch(() => {
        if (this.#accountIdPromise === pending) {
          this.#accountIdPromise = null;
        }
      });
    }
    return this.#accountIdPromise;
  }

  #getZoneId(token: string, accountId: string): Promise<string> {
    if (!this.#zoneIdPromise) {
      const pending = resolveZoneId(this.#env(), {
        token,
        accountId,
        fetcher: this.#fetcher
      });
      this.#zoneIdPromise = pending;
      pending.catch(() => {
        if (this.#zoneIdPromise === pending) {
          this.#zoneIdPromise = null;
        }
      });
    }
    return this.#zoneIdPromise;
  }
}
