import type { S3CredentialProxyParams } from '../types';
import { S3_CREDENTIAL_PROXY_HOST } from './container-proxy';
import type { R2EgressParams } from './r2-egress-handler';

type PersistedOverrides = Record<string, { method: string; params?: unknown }>;

/**
 * Bucket mount routes restored from a previous instance of this Durable
 * Object. The mount registry starts empty after a restart, but s3fs mounts in
 * a container that kept running still send requests, so every route update
 * keeps these routes until onStop() reports that container stopped. The base
 * class reports a stop it missed before it starts a new container.
 */
export class RestoredMountRoutes {
  r2Buckets: R2EgressParams['buckets'] = {};
  credentialProxyMounts: S3CredentialProxyParams['mounts'] = {};

  /**
   * Read the overrides the base Container restored from storage in its
   * constructor. `outboundByHostOverrides` is private in its types.
   */
  static fromContainer(container: unknown): RestoredMountRoutes {
    const overrides =
      (container as { outboundByHostOverrides?: PersistedOverrides })
        .outboundByHostOverrides ?? {};
    const routes = new RestoredMountRoutes();
    const r2 = overrides['r2.internal'];
    if (r2?.method === 'r2EgressMount') {
      routes.r2Buckets = {
        ...(r2.params as R2EgressParams | undefined)?.buckets
      };
    }
    const credentialProxy = overrides[S3_CREDENTIAL_PROXY_HOST];
    if (credentialProxy?.method === 's3CredentialProxyMount') {
      routes.credentialProxyMounts = {
        ...(credentialProxy.params as S3CredentialProxyParams | undefined)
          ?.mounts
      };
    }
    return routes;
  }
}
