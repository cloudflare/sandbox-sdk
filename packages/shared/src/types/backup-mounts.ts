// Backup types
/**
 * Options for creating a directory backup
 */
export interface BackupCompressionOptions {
  format?: 'gzip' | 'lz4' | 'zstd';
  threads?: number;
}

export interface BackupOptions {
  /** Directory to back up. Must be absolute and under `/workspace`, `/home`, `/tmp`, `/var/tmp`, or `/app`. */
  dir: string;
  /** Human-readable name for this backup. Optional. */
  name?: string;
  /** Seconds until automatic garbage collection. Default: 259200 (3 days). No upper limit. */
  ttl?: number;
  /**
   * Respect git ignore rules for the backup directory when it is inside a git repository.
   *
   * Default: false.
   * If the directory is not inside a git repository, no git-based exclusions are applied.
   * If git is not installed in the container, a warning is logged and gitignore rules are skipped.
   */
  gitignore?: boolean;
  /**
   * Glob patterns to exclude from the backup.
   * These are passed directly to mksquashfs as wildcard exclude patterns.
   *
   * @example ['node_modules', '*.log', '.cache']
   */
  excludes?: string[];
  /**
   * Use local R2 binding for backup storage instead of presigned URLs.
   * Required for local development where presigned URLs and FUSE are unavailable.
   * When true, the DO resolves BACKUP_BUCKET from its own env as an R2 binding.
   */
  localBucket?: boolean;
  compression?: BackupCompressionOptions;
  /**
   * Use parallel multipart upload to R2 for large archives.
   * Significantly speeds up uploads for archives over 10 MiB.
   * Default: true.
   */
  multipart?: boolean;
}

/**
 * Handle representing a stored directory backup.
 * Serializable metadata returned by createBackup().
 * Store it anywhere and later pass it to restoreBackup().
 */
export interface DirectoryBackup {
  /** Unique backup identifier */
  readonly id: string;
  /** Directory to restore into. Must be under `/workspace`, `/home`, `/tmp`, `/var/tmp`, or `/app`. */
  readonly dir: string;
  /** Whether this backup was created with local R2 binding mode. */
  readonly localBucket?: boolean;
}

/**
 * Result returned from a successful restoreBackup() call
 */
export interface RestoreBackupResult {
  success: boolean;
  /** The directory that was restored */
  dir: string;
  /** Backup ID that was restored */
  id: string;
}

// Bucket mounting types
/**
 * Supported S3-compatible storage providers
 */
export type BucketProvider =
  | 'r2' // Cloudflare R2
  | 's3' // Amazon S3
  | 'gcs'; // Google Cloud Storage

/**
 * Credentials for S3-compatible storage
 */
export interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Options for mounting an S3-compatible bucket via s3fs-FUSE (production)
 */
export interface RemoteMountBucketOptions {
  /**
   * S3-compatible endpoint URL
   *
   * Examples:
   * - R2: 'https://abc123.r2.cloudflarestorage.com'
   * - AWS S3: 'https://s3.us-west-2.amazonaws.com'
   * - GCS: 'https://storage.googleapis.com'
   */
  endpoint: string;

  /**
   * Optional provider hint for automatic s3fs flag configuration
   * If not specified, will attempt to detect from endpoint URL.
   *
   * Examples:
   * - 'r2' - Cloudflare R2 (adds nomixupload)
   * - 's3' - Amazon S3 (standard configuration)
   * - 'gcs' - Google Cloud Storage (no special flags needed)
   */
  provider?: BucketProvider;

  /**
   * Explicit credentials (overrides env var auto-detection)
   */
  credentials?: BucketCredentials;

  /**
   * Mount filesystem as read-only
   * Default: false
   */
  readOnly?: boolean;

  /**
   * Advanced: Override or extend s3fs options
   *
   * These will be merged with provider-specific defaults.
   * To override defaults completely, specify all options here.
   *
   * Common options:
   * - 'use_path_request_style' - Use path-style URLs (bucket/path vs bucket.host/path)
   * - 'nomixupload' - Disable mixed multipart uploads (needed for some providers)
   * - 'nomultipart' - Disable all multipart operations
   * - 'sigv2' - Use signature version 2 instead of v4
   * - 'no_check_certificate' - Skip SSL certificate validation (dev/testing only)
   */
  s3fsOptions?: string[];

  /**
   * Optional prefix/subdirectory within the bucket to mount.
   *
   * When specified, only the contents under this prefix are visible at the
   * mount point, scoping the mount to a subdirectory of the bucket.
   *
   * Must start with '/' (e.g., '/workspaces/project123' or '/data/uploads/')
   */
  prefix?: string;

  /**
   * Keep real credentials in the Durable Object; write dummy credentials into
   * the container-side s3fs password file. Outbound s3fs requests are
   * intercepted by the DO, signed with real credentials, and forwarded to the
   * configured endpoint.
   *
   * Default: false (real credentials are written into the container)
   */
  credentialProxy?: boolean;
}

/**
 * Options for mounting a local R2 binding via bidirectional sync (local dev)
 *
 * Used during local development with `wrangler dev`. The Durable Object
 * resolves the R2 binding from its own env using the `bucket` parameter
 * and syncs files via polling instead of s3fs-FUSE.
 */
export interface LocalMountBucketOptions {
  /**
   * Must be true to indicate local R2 binding mode.
   */
  localBucket: true;

  /**
   * Optional prefix/subdirectory within the bucket to sync.
   *
   * When specified, only the contents under this prefix will be visible
   * at the mount point.
   */
  prefix?: string;

  /**
   * Mount filesystem as read-only
   * Default: false
   */
  readOnly?: boolean;
}

/**
 * Options for mounting an R2 binding via credential-less egress interception.
 */
export interface R2BindingMountBucketOptions {
  /**
   * Must not be set — distinguishes this variant from RemoteMountBucketOptions.
   */
  endpoint?: never;

  /**
   * Optional prefix/subdirectory within the bucket to mount.
   *
   * When specified, only the contents under this prefix will be visible
   * at the mount point.
   */
  prefix?: string;

  /**
   * Mount filesystem as read-only
   * Default: false
   */
  readOnly?: boolean;

  /**
   * Advanced: Override or extend s3fs options.
   * Provider defaults for R2 are still applied automatically.
   */
  s3fsOptions?: string[];
}

/**
 * Options for mounting a bucket — remote (s3fs-FUSE), local (R2 binding sync),
 * or R2 egress (credential-less s3fs via egress interception).
 */
export type MountBucketOptions =
  | RemoteMountBucketOptions
  | LocalMountBucketOptions
  | R2BindingMountBucketOptions;
