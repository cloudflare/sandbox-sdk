import type { BucketCredentials } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import type { S3FSHost } from './host';

const S3FS_DISABLE_EXPECT_HEADER_CONFIG = ' Expect:\n';

export function generatePasswordFilePath(): string {
  return `/tmp/.passwd-s3fs-${crypto.randomUUID()}`;
}

export function generateS3FSAdditionalHeaderFilePath(): string {
  return `/tmp/.s3fs-ahbe-${crypto.randomUUID()}.conf`;
}

export async function createDisableExpectHeaderFile(
  host: S3FSHost,
  headerFilePath: string
): Promise<void> {
  await host.client.files.writeFile(
    headerFilePath,
    S3FS_DISABLE_EXPECT_HEADER_CONFIG
  );
  await host.execInternal(`chmod 0600 ${shellEscape(headerFilePath)}`);
}

export async function createPasswordFile(
  host: S3FSHost,
  passwordFilePath: string,
  bucket: string,
  credentials: BucketCredentials
): Promise<void> {
  const content = `${bucket}:${credentials.accessKeyId}:${credentials.secretAccessKey}`;
  await host.client.files.writeFile(passwordFilePath, content);
  await host.execInternal(`chmod 0600 ${shellEscape(passwordFilePath)}`);
}

export async function deletePasswordFile(
  host: S3FSHost,
  passwordFilePath: string
): Promise<void> {
  try {
    await host.execInternal(`rm -f ${shellEscape(passwordFilePath)}`);
  } catch (error) {
    host.logger.warn('password file cleanup failed', {
      passwordFilePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function deleteAdditionalHeaderFile(
  host: S3FSHost,
  headerFilePath: string
): Promise<void> {
  try {
    await host.execInternal(`rm -f ${shellEscape(headerFilePath)}`);
  } catch (error) {
    host.logger.warn('s3fs additional header file cleanup failed', {
      headerFilePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
