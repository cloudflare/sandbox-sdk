import type { Logger } from '@repo/shared';
import type { HTTPAuthInterceptorParams } from '../../extensions/index.js';

type GitAuthInterceptorParams = HTTPAuthInterceptorParams;

import { InvalidMountConfigError } from '../errors';
import type { MountInfo, S3CredentialProxyParams } from '../types';
import {
  CONTAINER_PROXY_CLASS_NAME,
  S3_CREDENTIAL_PROXY_DIAGNOSTIC_HOST,
  S3_CREDENTIAL_PROXY_HOST
} from './container-proxy';
import { buildR2EgressParams, buildS3CredentialProxyParams } from './params';
import type { R2EgressParams } from './r2-egress-handler';
import type { RestoredMountRoutes } from './restored-routes';
import {
  evictDirectoryMarkerCacheForMount,
  evictSigV4ClientCacheEntry,
  SELF_TEST_PATH as S3_CREDENTIAL_PROXY_SELF_TEST_PATH
} from './s3-credential-proxy-handler';

export type EgressContainerState = DurableObjectState<{}> & {
  exports?: {
    ContainerProxy?: (options: {
      props: {
        enableInternet?: boolean;
        containerId: string;
        className: string;
        outboundByHostOverrides: Record<
          string,
          {
            method: string;
            params:
              | R2EgressParams
              | S3CredentialProxyParams
              | GitAuthInterceptorParams;
          }
        >;
      };
    }) => Fetcher;
  };
  container?: {
    interceptOutboundHttp(host: string, fetcher: Fetcher): Promise<void>;
  };
};

export interface MountOutboundHost {
  ctx: EgressContainerState;
  restoredMountRoutes: RestoredMountRoutes;
  enableInternet?: boolean;
  logger: Logger;
  setOutboundByHost<T>(host: string, method: string, params: T): Promise<void>;
  removeOutboundByHost(host: string): Promise<void>;
}

function isFetcher(value: unknown): value is Fetcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function'
  );
}

export async function configureR2EgressOutbound(
  host: MountOutboundHost,
  activeParams: R2EgressParams
): Promise<void> {
  const params: R2EgressParams = {
    buckets: {
      ...host.restoredMountRoutes.r2Buckets,
      ...activeParams.buckets
    }
  };
  const ctx = host.ctx;
  if (!ctx.container?.interceptOutboundHttp) {
    throw new InvalidMountConfigError(
      'R2 binding mounts require container outbound interception support'
    );
  }
  if (!ctx.exports?.ContainerProxy) {
    throw new InvalidMountConfigError(
      'R2 binding mounts require exporting ContainerProxy from the Worker entrypoint'
    );
  }

  if (Object.keys(params.buckets).length > 0) {
    await host.setOutboundByHost<R2EgressParams>(
      'r2.internal',
      'r2EgressMount',
      params
    );
  } else {
    await host.removeOutboundByHost('r2.internal');
  }

  host.logger.debug('r2 egress: registering host interception', {
    host: 'r2.internal',
    method: 'r2EgressMount',
    targetClassName: CONTAINER_PROXY_CLASS_NAME
  });

  const fetcher = ctx.exports.ContainerProxy({
    props: {
      enableInternet: host.enableInternet,
      containerId: ctx.id.toString(),
      className: CONTAINER_PROXY_CLASS_NAME,
      outboundByHostOverrides: {
        'r2.internal': {
          method: 'r2EgressMount',
          params
        }
      }
    }
  });
  if (!isFetcher(fetcher)) {
    throw new InvalidMountConfigError(
      'R2 binding mounts require ContainerProxy to return a valid Fetcher'
    );
  }

  await ctx.container.interceptOutboundHttp('r2.internal', fetcher);
}

export async function configureGitAuthInterceptor(
  host: MountOutboundHost,
  params: GitAuthInterceptorParams
): Promise<void> {
  const ctx = host.ctx;
  if (!ctx.container?.interceptOutboundHttp) {
    throw new InvalidMountConfigError(
      'Git extension authentication requires container outbound interception support'
    );
  }
  if (!ctx.exports?.ContainerProxy) {
    throw new InvalidMountConfigError(
      'Git extension authentication requires exporting ContainerProxy from the Worker entrypoint. Import ContainerProxy from @cloudflare/sandbox and export it from your Worker to use git auth interception.'
    );
  }

  const hostOverrides: Record<
    string,
    { method: string; params: GitAuthInterceptorParams }
  > = {};
  for (const outboundHost of Object.keys(params.hosts)) {
    hostOverrides[outboundHost] = { method: 'gitCredentialProxy', params };
    await host.setOutboundByHost<GitAuthInterceptorParams>(
      outboundHost,
      'gitCredentialProxy',
      params
    );
  }

  const fetcher = ctx.exports.ContainerProxy({
    props: {
      enableInternet: host.enableInternet,
      containerId: ctx.id.toString(),
      className: CONTAINER_PROXY_CLASS_NAME,
      outboundByHostOverrides: hostOverrides
    }
  });
  if (!isFetcher(fetcher)) {
    throw new InvalidMountConfigError(
      'Git extension authentication requires ContainerProxy to return a valid Fetcher'
    );
  }

  for (const outboundHost of Object.keys(params.hosts)) {
    await ctx.container.interceptOutboundHttp(outboundHost, fetcher);
  }
}

export async function configureS3CredentialProxyOutbound(
  host: MountOutboundHost,
  activeParams: S3CredentialProxyParams
): Promise<void> {
  const params: S3CredentialProxyParams = {
    mounts: {
      ...host.restoredMountRoutes.credentialProxyMounts,
      ...activeParams.mounts
    }
  };
  const ctx = host.ctx;
  if (!ctx.container?.interceptOutboundHttp) {
    throw new InvalidMountConfigError(
      'Credential proxy bucket mounts require container outbound interception support'
    );
  }
  if (!ctx.exports?.ContainerProxy) {
    throw new InvalidMountConfigError(
      'Credential proxy bucket mounts require exporting ContainerProxy from the Worker entrypoint'
    );
  }

  const hosts = [S3_CREDENTIAL_PROXY_HOST, S3_CREDENTIAL_PROXY_DIAGNOSTIC_HOST];

  if (Object.keys(params.mounts).length > 0) {
    for (const outboundHost of hosts) {
      await host.setOutboundByHost<S3CredentialProxyParams>(
        outboundHost,
        's3CredentialProxyMount',
        params
      );
    }
  } else {
    for (const outboundHost of hosts) {
      await host.removeOutboundByHost(outboundHost);
    }
  }

  const hostOverrides: Record<
    string,
    { method: string; params: S3CredentialProxyParams }
  > = {};
  for (const outboundHost of hosts) {
    hostOverrides[outboundHost] = {
      method: 's3CredentialProxyMount',
      params
    };
  }

  host.logger.debug('s3 credential proxy: registering host interception', {
    hosts,
    method: 's3CredentialProxyMount',
    targetClassName: CONTAINER_PROXY_CLASS_NAME
  });

  const fetcher = ctx.exports.ContainerProxy({
    props: {
      enableInternet: host.enableInternet,
      containerId: ctx.id.toString(),
      className: CONTAINER_PROXY_CLASS_NAME,
      outboundByHostOverrides: hostOverrides
    }
  });
  if (!isFetcher(fetcher)) {
    throw new InvalidMountConfigError(
      'Credential proxy bucket mounts require ContainerProxy to return a valid Fetcher'
    );
  }

  try {
    const selfTest = await fetcher.fetch(
      new Request(
        `http://${S3_CREDENTIAL_PROXY_HOST}${S3_CREDENTIAL_PROXY_SELF_TEST_PATH}`
      )
    );
    await selfTest.text();
    host.logger.debug('s3 credential proxy: fetcher self-test complete', {
      status: selfTest.status
    });
  } catch (error) {
    host.logger.warn('s3 credential proxy: fetcher self-test failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  for (const outboundHost of hosts) {
    await ctx.container.interceptOutboundHttp(outboundHost, fetcher);
  }
}

/**
 * Drop the routes restored for the mounts of a container that has stopped.
 */
export async function releaseRestoredMountRoutes(
  host: MountOutboundHost,
  mounts: Iterable<[string, MountInfo]>
): Promise<void> {
  const routes = host.restoredMountRoutes;
  for (const mountId of Object.keys(routes.credentialProxyMounts)) {
    evictSigV4ClientCacheEntry(mountId);
    evictDirectoryMarkerCacheForMount(mountId);
  }
  if (Object.keys(routes.r2Buckets).length > 0) routes.staleR2 = true;
  if (Object.keys(routes.credentialProxyMounts).length > 0) {
    routes.staleCredentialProxy = true;
  }
  routes.r2Buckets = {};
  routes.credentialProxyMounts = {};
  await removeStaleMountRoutes(host, mounts);
}

/**
 * Rewrite the routes that still carry a stopped container's restored mounts
 * so they cover only `mounts`. A failed update stays marked and is retried on
 * the next container start or stop.
 */
export async function removeStaleMountRoutes(
  host: MountOutboundHost,
  mounts: Iterable<[string, MountInfo]>
): Promise<void> {
  const routes = host.restoredMountRoutes;
  if (routes.staleR2) {
    try {
      await configureR2EgressOutbound(host, buildR2EgressParams(mounts));
      routes.staleR2 = false;
    } catch (error) {
      host.logger.warn('Failed to remove stale R2 mount routes', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (routes.staleCredentialProxy) {
    try {
      await configureS3CredentialProxyOutbound(
        host,
        buildS3CredentialProxyParams(mounts)
      );
      routes.staleCredentialProxy = false;
    } catch (error) {
      host.logger.warn('Failed to remove stale credential proxy mount routes', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
