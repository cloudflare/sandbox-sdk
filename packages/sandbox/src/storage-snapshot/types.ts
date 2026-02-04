/**
 * Types for R2/S3 snapshot operations
 */

import type { BucketCredentials } from '@repo/shared';

/**
 * Options for creating a directory snapshot to R2/S3
 */
export interface SnapshotR2Options {
  /** R2/S3 bucket name */
  bucket: string;

  /**
   * R2/S3 endpoint URL
   * For R2: https://ACCOUNT_ID.r2.cloudflarestorage.com
   * For S3: https://s3.REGION.amazonaws.com
   */
  endpoint: string;

  /** R2/S3 API credentials */
  credentials: BucketCredentials;

  /**
   * Optional key prefix for organizing snapshots
   * @default "snapshots/"
   */
  keyPrefix?: string;

  /**
   * zstd compression level (1-19)
   * Higher = better compression, slower
   * @default 3
   */
  compressionLevel?: number;
}

/**
 * Options for applying a snapshot from R2/S3
 */
export interface ApplySnapshotR2Options extends SnapshotR2Options {
  /**
   * Target directory to extract snapshot into
   * If not specified, uses /workspace
   */
  targetDirectory?: string;
}
