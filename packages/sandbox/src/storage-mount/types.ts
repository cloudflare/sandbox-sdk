/**
 * Internal bucket mounting types
 */

import type { BucketCredentials, BucketProvider } from '@repo/shared';

/**
 * Internal tracking information for active mounts
 */
export interface MountInfo {
  bucket: string;
  mountPath: string;
  endpoint: string;
  provider: BucketProvider | null;
  credentials: BucketCredentials;
  mounted: boolean;
}
