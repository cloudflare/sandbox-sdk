/**
 * Provider detection and s3fs flag configuration
 *
 * Based on s3fs-fuse documentation:
 * https://github.com/s3fs-fuse/s3fs-fuse/wiki/Non-Amazon-S3
 */

import type { BucketProvider } from '@repo/shared';

/**
 * Detect provider from endpoint URL using pattern matching
 */
export function detectProviderFromUrl(endpoint: string): BucketProvider | null {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();

    if (hostname.endsWith('.r2.cloudflarestorage.com')) {
      return 'r2';
    }

    if (hostname.endsWith('.amazonaws.com') || hostname.startsWith('s3.')) {
      return 's3';
    }

    if (hostname === 'storage.googleapis.com') {
      return 'gcs';
    }

    if (hostname.includes('minio') || url.port === '9000') {
      return 'minio';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get s3fs flags for a given provider
 *
 * Based on s3fs-fuse wiki recommendations:
 * https://github.com/s3fs-fuse/s3fs-fuse/wiki/Non-Amazon-S3
 */
export function getProviderFlags(provider: BucketProvider | null): string[] {
  if (!provider) {
    return ['use_path_request_style'];
  }

  switch (provider) {
    case 'r2':
      return ['nomixupload', 'endpoint=auto'];

    case 's3':
      return [];

    case 'gcs':
      return [];

    case 'minio':
      return ['use_path_request_style'];

    default:
      return ['use_path_request_style'];
  }
}

/**
 * Resolve s3fs options by combining provider defaults with user overrides
 */
export function resolveS3fsOptions(
  provider: BucketProvider | null,
  userOptions?: string[]
): string[] {
  const providerFlags = getProviderFlags(provider);

  if (!userOptions || userOptions.length === 0) {
    return providerFlags;
  }

  // Merge provider flags with user options
  // User options take precedence (come last in the array)
  const allFlags = [...providerFlags, ...userOptions];

  // Deduplicate flags (keep last occurrence)
  const flagMap = new Map<string, string>();

  for (const flag of allFlags) {
    // Split on '=' to get the flag name
    const [flagName] = flag.split('=');
    flagMap.set(flagName, flag);
  }

  return Array.from(flagMap.values());
}
