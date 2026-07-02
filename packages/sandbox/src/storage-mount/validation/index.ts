import type { RemoteMountBucketOptions } from '@repo/shared';
import { InvalidMountConfigError } from '../errors';
import type { MountInfo } from '../types';

/**
 * Type guard for R2Bucket binding.
 * Checks for the minimal R2Bucket interface methods we use.
 */
export function isR2Bucket(value: unknown): value is R2Bucket {
  return (
    typeof value === 'object' &&
    value !== null &&
    'put' in value &&
    typeof (value as Record<string, unknown>).put === 'function' &&
    'get' in value &&
    typeof (value as Record<string, unknown>).get === 'function' &&
    'head' in value &&
    typeof (value as Record<string, unknown>).head === 'function' &&
    'delete' in value &&
    typeof (value as Record<string, unknown>).delete === 'function' &&
    'list' in value &&
    typeof (value as Record<string, unknown>).list === 'function'
  );
}

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

export function validateMountPath(
  activeMounts: Map<string, MountInfo>,
  mountPath: string
): void {
  if (!mountPath.startsWith('/')) {
    throw new InvalidMountConfigError(
      `Mount path must be absolute (start with /): "${mountPath}"`
    );
  }

  if (activeMounts.has(mountPath)) {
    const existingMount = activeMounts.get(mountPath);
    throw new InvalidMountConfigError(
      `Mount path "${mountPath}" is already in use by bucket "${existingMount?.bucket}". ` +
        'Unmount the existing bucket first or use a different mount path.'
    );
  }
}

export function validateRemoteMountOptions(
  activeMounts: Map<string, MountInfo>,
  bucket: string,
  mountPath: string,
  options: RemoteMountBucketOptions
): void {
  try {
    new URL(options.endpoint);
  } catch (error) {
    throw new InvalidMountConfigError(
      `Invalid endpoint URL: "${options.endpoint}". Must be a valid HTTP(S) URL.`
    );
  }

  validateBucketName(bucket, mountPath);
  validateMountPath(activeMounts, mountPath);
}

export function validateBucketBindingName(
  bucketBinding: string,
  mountPath: string
): void {
  if (bucketBinding.includes(':')) {
    const [bucketName, prefixPart] = bucketBinding.split(':');
    throw new InvalidMountConfigError(
      `Bucket name cannot contain ':'. To mount a prefix, use the 'prefix' option:\n` +
        `  mountBucket('${bucketName}', '${mountPath}', { ...options, prefix: '${prefixPart}' })`
    );
  }

  // Worker binding names follow JavaScript identifier syntax.
  const bindingNameRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!bindingNameRegex.test(bucketBinding)) {
    throw new InvalidMountConfigError(
      `Invalid R2 binding name: "${bucketBinding}". Binding names must start with a letter or underscore and contain only letters, numbers, or underscores.`
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
