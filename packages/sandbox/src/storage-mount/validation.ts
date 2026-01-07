/**
 * Pure validation functions for bucket mounting
 */

import { InvalidMountConfigError } from './errors';

/**
 * Validates that a prefix follows s3fs format requirements.
 * Prefix must start and end with '/' (e.g., '/path/to/data/')
 *
 * @param prefix - The prefix to validate
 * @throws InvalidMountConfigError if prefix format is invalid
 */
export function validatePrefix(prefix: string): void {
  if (!prefix.startsWith('/')) {
    throw new InvalidMountConfigError(
      `Prefix must start with '/': "${prefix}"`
    );
  }
  if (!prefix.endsWith('/')) {
    throw new InvalidMountConfigError(`Prefix must end with '/': "${prefix}"`);
  }
}

/**
 * Builds the s3fs source string from bucket name and optional prefix.
 * Format: "bucket" or "bucket:/prefix/" for subdirectory mounts.
 *
 * @param bucket - The bucket name
 * @param prefix - Optional prefix/subdirectory path
 * @returns The s3fs source string
 */
export function buildS3fsSource(bucket: string, prefix?: string): string {
  return prefix ? `${bucket}:${prefix}` : bucket;
}
