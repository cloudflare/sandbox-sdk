/**
 * Internal bucket mounting types
 */

import type { BucketCredentials, BucketProvider } from '@repo/shared';
import type { LocalMountSyncManager } from '../local-mount-sync';

/**
 * Internal tracking information for active mounts
 */
export type MountInfo = FuseMountInfo | LocalSyncMountInfo | R2BindingMountInfo;

export type CredentialProxyAuthStrategy = 's3-sigv4' | 'gcs';

export interface CredentialProxyConfig {
  endpoint: string;
  bucket: string;
  prefix?: string;
  credentials: BucketCredentials;
  readOnly: boolean;
  provider: BucketProvider | null;
  authStrategy: CredentialProxyAuthStrategy;
}

export type S3CredentialProxyParams = {
  mounts: Record<string, CredentialProxyConfig>;
};

export interface FuseMountInfo {
  mountId: string;
  mountType: 'fuse';
  bucket: string;
  mountPath: string;
  endpoint: string;
  provider: BucketProvider | null;
  passwordFilePath: string;
  additionalHeaderFilePath?: string;
  mounted: boolean;
  credentialProxy?: CredentialProxyConfig;
}

export interface LocalSyncMountInfo {
  mountId: string;
  mountType: 'local-sync';
  bucket: string;
  mountPath: string;
  syncManager: LocalMountSyncManager;
  mounted: boolean;
}

export interface R2BindingMountInfo {
  mountId: string;
  mountType: 'r2-egress';
  bucket: string;
  mountPath: string;
  passwordFilePath: string;
  additionalHeaderFilePath?: string;
  mounted: boolean;
  prefix?: string;
  readOnly: boolean;
}

export type R2EgressMountInfo = R2BindingMountInfo;
