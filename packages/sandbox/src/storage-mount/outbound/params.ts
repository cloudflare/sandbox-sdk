import type {
  FuseMountInfo,
  MountInfo,
  S3CredentialProxyParams
} from '../types';
import type { R2EgressParams } from './r2-egress-handler';

function hasExcludedID(
  excludedIDs: Iterable<string> | undefined,
  mountId: string
): boolean {
  if (!excludedIDs) return false;
  for (const excludedID of excludedIDs) {
    if (excludedID === mountId) return true;
  }
  return false;
}

export function buildR2EgressParams(
  mounts: Iterable<[string, MountInfo]>,
  options?: {
    excludeMountId?: string;
    excludeMountIds?: Iterable<string>;
  }
): R2EgressParams {
  const buckets: R2EgressParams['buckets'] = {};
  for (const [, mountInfo] of mounts) {
    if (
      mountInfo.mountType === 'r2-egress' &&
      mountInfo.mountId !== options?.excludeMountId &&
      !hasExcludedID(options?.excludeMountIds, mountInfo.mountId)
    ) {
      buckets[mountInfo.bucket] = {
        prefix: mountInfo.prefix,
        readOnly: mountInfo.readOnly
      };
    }
  }
  return { buckets };
}

export function buildS3CredentialProxyParams(
  mounts: Iterable<[string, MountInfo]>,
  options?: {
    excludeMountId?: string;
    excludeMountIds?: Iterable<string>;
    includeMount?: FuseMountInfo;
  }
): S3CredentialProxyParams {
  const params: S3CredentialProxyParams['mounts'] = {};
  const addMount = (mountInfo: FuseMountInfo) => {
    if (
      !mountInfo.credentialProxy ||
      mountInfo.mountId === options?.excludeMountId ||
      hasExcludedID(options?.excludeMountIds, mountInfo.mountId)
    ) {
      return;
    }
    params[mountInfo.mountId] = {
      endpoint: mountInfo.credentialProxy.endpoint,
      bucket: mountInfo.credentialProxy.bucket,
      ...(mountInfo.credentialProxy.prefix !== undefined
        ? { prefix: mountInfo.credentialProxy.prefix }
        : {}),
      credentials: mountInfo.credentialProxy.credentials,
      readOnly: mountInfo.credentialProxy.readOnly,
      provider: mountInfo.credentialProxy.provider,
      authStrategy: mountInfo.credentialProxy.authStrategy
    };
  };

  for (const [, mountInfo] of mounts) {
    if (mountInfo.mountType === 'fuse') addMount(mountInfo);
  }
  if (options?.includeMount) addMount(options.includeMount);
  return { mounts: params };
}
