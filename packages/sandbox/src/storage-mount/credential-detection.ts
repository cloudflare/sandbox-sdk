import type { BucketCredentials, MountBucketOptions } from '@repo/shared';
import { MissingCredentialsError } from './errors';

/**
 * Detect credentials for bucket mounting from environment variables
 * Priority order:
 * 1. Explicit options.credentials
 * 2. Standard AWS env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * 3. Error: no credentials found
 *
 * @param options - Mount options
 * @param envVars - Environment variables
 * @returns Detected credentials
 * @throws MissingCredentialsError if no credentials found
 */
export function detectCredentials(
  options: MountBucketOptions,
  envVars: Record<string, string | undefined>
): BucketCredentials {
  // Priority 1: Explicit credentials in options
  if (options.credentials) {
    return options.credentials;
  }

  // Priority 2: Standard AWS env vars
  const awsAccessKeyId = envVars.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = envVars.AWS_SECRET_ACCESS_KEY;

  if (awsAccessKeyId && awsSecretAccessKey) {
    return {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey
    };
  }

  // No credentials found - throw error with helpful message
  throw new MissingCredentialsError(
    `No credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY ` +
      `environment variables, or pass explicit credentials in options.`
  );
}
