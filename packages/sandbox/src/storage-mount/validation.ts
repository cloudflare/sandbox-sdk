import { InvalidMountConfigError } from './errors';

export function validatePrefix(prefix: string): void {
  if (!prefix.startsWith('/')) {
    throw new InvalidMountConfigError(
      `Prefix must start with '/': "${prefix}"`
    );
  }
}

export function validateBucketName(bucket: string, mountPath: string): void {
  if (bucket.includes(':')) {
    const [bucketName, prefixPart] = bucket.split(':');
    throw new InvalidMountConfigError(
      `Bucket name cannot contain ':'. To mount a prefix, use the 'prefix' option:\n` +
        `  mountBucket('${bucketName}', '${mountPath}', { ...options, prefix: '${prefixPart}' })`
    );
  }

  const bucketNameRegex = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
  if (!bucketNameRegex.test(bucket)) {
    throw new InvalidMountConfigError(
      `Invalid bucket name: "${bucket}". Bucket names must be 3-63 characters, ` +
        `lowercase alphanumeric, dots, or hyphens, and cannot start/end with dots or hyphens.`
    );
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
