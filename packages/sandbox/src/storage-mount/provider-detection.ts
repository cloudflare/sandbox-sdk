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

    // Cloudflare R2
    if (hostname.includes('.r2.cloudflarestorage.com')) {
      return 'r2';
    }

    // Backblaze B2 (check before S3 as it contains 's3.' in URL)
    if (hostname.includes('.backblazeb2.com')) {
      return 'backblaze';
    }

    // Wasabi (check before S3 as it contains 's3.' in URL)
    if (hostname.includes('.wasabisys.com')) {
      return 'wasabi';
    }

    // Amazon S3
    if (hostname.includes('.amazonaws.com') || hostname.startsWith('s3.')) {
      return 's3';
    }

    // Google Cloud Storage
    if (hostname === 'storage.googleapis.com') {
      return 'gcs';
    }

    // MinIO (common patterns: port 9000 or 'minio' in hostname)
    if (hostname.includes('minio') || url.port === '9000') {
      return 'minio';
    }

    // DigitalOcean Spaces
    if (hostname.includes('.digitaloceanspaces.com')) {
      return 'digitalocean';
    }

    // Unknown provider
    return null;
  } catch {
    // Invalid URL
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
    // Safe default for unknown providers
    return ['use_path_request_style'];
  }

  switch (provider) {
    case 'r2':
      // Cloudflare R2 requires nomixupload and endpoint=auto
      return ['nomixupload', 'endpoint=auto'];

    case 's3':
      // AWS S3 works with defaults (virtual-hosted style)
      return [];

    case 'gcs':
      // Google Cloud Storage works with defaults (s3fs 1.90+)
      return [];

    case 'minio':
      // MinIO requires path-style requests
      return ['use_path_request_style'];

    case 'backblaze':
      // Backblaze B2 works with defaults
      return [];

    case 'wasabi':
      // Wasabi works with defaults
      return [];

    case 'digitalocean':
      // DigitalOcean Spaces works with defaults
      return [];

    case 'custom':
      // Custom provider - user must specify all flags
      return [];

    default:
      // Fallback to safe defaults
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

