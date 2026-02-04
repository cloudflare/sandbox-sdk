/**
 * Presigned URL generation for R2/S3 snapshot operations
 *
 * Uses AWS SDK v3 to generate short-lived presigned URLs for secure
 * upload/download without exposing credentials to the container.
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BucketCredentials } from '@repo/shared';

/** Default presigned URL expiration: 10 minutes */
const DEFAULT_EXPIRY_SECONDS = 600;

/**
 * Create an S3-compatible client for R2 or S3
 */
export function createS3Client(
  endpoint: string,
  credentials: BucketCredentials
): S3Client {
  return new S3Client({
    region: 'auto', // Required by SDK but R2 ignores it
    endpoint,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  });
}

/**
 * Generate a presigned PUT URL for uploading a snapshot
 *
 * @param client - S3 client
 * @param bucket - Bucket name
 * @param key - Object key (path within bucket)
 * @param expiresIn - URL validity in seconds (default: 600)
 * @returns Presigned PUT URL
 */
export async function generatePresignedPutUrl(
  client: S3Client,
  bucket: string,
  key: string,
  expiresIn: number = DEFAULT_EXPIRY_SECONDS
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: 'application/octet-stream'
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Generate a presigned GET URL for downloading a snapshot
 *
 * @param client - S3 client
 * @param bucket - Bucket name
 * @param key - Object key (path within bucket)
 * @param expiresIn - URL validity in seconds (default: 600)
 * @returns Presigned GET URL
 */
export async function generatePresignedGetUrl(
  client: S3Client,
  bucket: string,
  key: string,
  expiresIn: number = DEFAULT_EXPIRY_SECONDS
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });

  return getSignedUrl(client, command, { expiresIn });
}
