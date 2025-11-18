/**
 * Internal bucket mounting types
 */

import type { BucketProvider } from '@repo/shared';

/**
 * Internal tracking information for active mounts
 */
export interface MountInfo {
  bucket: string;
  mountPath: string;
  endpoint: string;
  provider: BucketProvider | null;
  passwordFilePath: string;
  mounted: boolean;
}
