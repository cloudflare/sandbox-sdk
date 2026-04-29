/**
 * Internal bucket mounting types
 */

import type { BucketProvider } from '@repo/shared';
import type { LocalMountSyncManager } from '../local-mount-sync';

/**
 * Internal tracking information for active mounts
 */
export type MountInfo = FuseMountInfo | LocalSyncMountInfo | R2EgressMountInfo;

export interface FuseMountInfo {
  mountType: 'fuse';
  bucket: string;
  mountPath: string;
  endpoint: string;
  provider: BucketProvider | null;
  passwordFilePath: string;
  mounted: boolean;
}

export interface LocalSyncMountInfo {
  mountType: 'local-sync';
  bucket: string;
  mountPath: string;
  syncManager: LocalMountSyncManager;
  mounted: boolean;
}

export interface R2EgressMountInfo {
  mountType: 'r2-egress';
  bucket: string;
  mountPath: string;
  passwordFilePath: string;
  mounted: boolean;
  prefix?: string;
}
