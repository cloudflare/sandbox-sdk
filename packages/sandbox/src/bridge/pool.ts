/**
 * Pool management helpers for the bridge.
 */

import type { BridgeEnv } from './types';
import type { WarmPoolConfig } from './warm-pool';

/**
 * Parse warm-pool configuration from bridge env vars.
 *
 * `WARM_POOL_MAX_INSTANCES` should match `containers[].max_instances` in
 * wrangler.jsonc. 0/unset means auto-learn the ceiling reactively.
 */
export function parsePoolConfig(env: BridgeEnv): Required<WarmPoolConfig> {
  const warmTarget =
    Number.parseInt((env.WARM_POOL_TARGET as string) || '0', 10) || 0;
  const refreshInterval =
    Number.parseInt(
      (env.WARM_POOL_REFRESH_INTERVAL as string) || '10000',
      10
    ) || 10_000;
  const maxInstances =
    Number.parseInt((env.WARM_POOL_MAX_INSTANCES as string) || '0', 10) || 0;
  const scaleBatchSize =
    Number.parseInt((env.WARM_POOL_SCALE_BATCH_SIZE as string) || '5', 10) || 5;

  return { warmTarget, refreshInterval, maxInstances, scaleBatchSize };
}

/**
 * Prime the warm pool — pushes current configuration to the WarmPool
 * Durable Object so it starts its alarm loop.
 *
 * Called by the scheduled() handler and by POST /pool/prime.
 */
export async function primePool(
  env: BridgeEnv,
  warmPoolBinding: string
): Promise<void> {
  const config = parsePoolConfig(env);

  const ns = env[warmPoolBinding] as DurableObjectNamespace;
  const poolId = ns.idFromName('global-pool');
  const poolStub = ns.get(poolId);
  await (poolStub as any).configure(config);
}
