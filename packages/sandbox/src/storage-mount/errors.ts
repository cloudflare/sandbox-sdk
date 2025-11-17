/**
 * Bucket mounting error classes
 *
 * These are SDK-side validation errors that follow the same pattern as SecurityError.
 * They are thrown before any container interaction occurs.
 */

import { ErrorCode } from '@repo/shared/errors';

/**
 * Base error for bucket mounting operations
 */
export class BucketMountError extends Error {
  public readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode = ErrorCode.BUCKET_MOUNT_ERROR) {
    super(message);
    this.name = 'BucketMountError';
    this.code = code;
  }
}

/**
 * Thrown when S3FS mount command fails
 */
export class S3FSMountError extends BucketMountError {
  constructor(message: string) {
    super(message, ErrorCode.S3FS_MOUNT_ERROR);
    this.name = 'S3FSMountError';
  }
}

/**
 * Thrown when no credentials found in environment
 */
export class MissingCredentialsError extends BucketMountError {
  constructor(message: string) {
    super(message, ErrorCode.MISSING_CREDENTIALS);
    this.name = 'MissingCredentialsError';
  }
}

/**
 * Thrown when bucket name, mount path, or options are invalid
 */
export class InvalidMountConfigError extends BucketMountError {
  constructor(message: string) {
    super(message, ErrorCode.INVALID_MOUNT_CONFIG);
    this.name = 'InvalidMountConfigError';
  }
}
