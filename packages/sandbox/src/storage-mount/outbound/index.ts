import type { Logger } from '@repo/shared';
import type { GitAuthInterceptorParams } from '../../git/types';
import { InvalidMountConfigError } from '../errors';
import type { S3CredentialProxyParams } from '../types';
import {
  CONTAINER_PROXY_CLASS_NAME,
  installSDKOutboundHandlers,
  S3_CREDENTIAL_PROXY_DIAGNOSTIC_HOST,
  S3_CREDENTIAL_PROXY_HOST
} from './container-proxy';
import type { R2EgressParams } from './r2-egress-handler';
import { SELF_TEST_PATH as S3_CREDENTIAL_PROXY_SELF_TEST_PATH } from './s3-credential-proxy-handler';

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
  constructorRef: Function;
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
  params: R2EgressParams
): Promise<void> {
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

  installSDKOutboundHandlers(host.constructorRef);
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

  installSDKOutboundHandlers(host.constructorRef);

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
  params: S3CredentialProxyParams
): Promise<void> {
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

  installSDKOutboundHandlers(host.constructorRef);
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
