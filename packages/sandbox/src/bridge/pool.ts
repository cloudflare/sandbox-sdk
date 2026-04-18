/**
 * Pool management helpers for the bridge.
 */

import type { BridgeEnv } from './types';

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
  const warmTarget =
    Number.parseInt((env.WARM_POOL_TARGET as string) || '0', 10) || 0;
  const refreshInterval =
    Number.parseInt(
      (env.WARM_POOL_REFRESH_INTERVAL as string) || '10000',
      10
    ) || 10_000;

  const ns = env[warmPoolBinding] as DurableObjectNamespace;
  const poolId = ns.idFromName('global-pool');
  const poolStub = ns.get(poolId);
  await (poolStub as any).configure({ warmTarget, refreshInterval });
}
