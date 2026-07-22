import type { BucketCredentials } from '@repo/shared';
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
  await host.runRuntimeCall('mount.s3fs.writeHeaderFile', (control) =>
    control.files.writeFile(headerFilePath, S3FS_DISABLE_EXPECT_HEADER_CONFIG)
  );
  await host.runRuntimeCall('mount.s3fs.chmodHeaderFile', (control) =>
    control.mounts.chmodOwnerOnly(headerFilePath)
  );
}

export async function createPasswordFile(
  host: S3FSHost,
  passwordFilePath: string,
  bucket: string,
  credentials: BucketCredentials
): Promise<void> {
  const content = `${bucket}:${credentials.accessKeyId}:${credentials.secretAccessKey}`;
  await host.runRuntimeCall('mount.s3fs.writePasswordFile', (control) =>
    control.files.writeFile(passwordFilePath, content)
  );
  await host.runRuntimeCall('mount.s3fs.chmodPasswordFile', (control) =>
    control.mounts.chmodOwnerOnly(passwordFilePath)
  );
}

export async function deletePasswordFile(
  host: S3FSHost,
  passwordFilePath: string
): Promise<void> {
  try {
    await host.runRuntimeCall('mount.s3fs.deletePasswordFile', (control) =>
      control.mounts.deleteFile(passwordFilePath)
    );
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
    await host.runRuntimeCall('mount.s3fs.deleteHeaderFile', (control) =>
      control.mounts.deleteFile(headerFilePath)
    );
  } catch (error) {
    host.logger.warn('s3fs additional header file cleanup failed', {
      headerFilePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
