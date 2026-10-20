import type { BucketCredentials } from '@repo/shared';
import type { S3FSHost } from './host';

const S3FS_DISABLE_EXPECT_HEADER_CONFIG = ' Expect:\n';

// s3fs refuses support files that other users can read. Create them with mode
// 0600 so the password file is never readable while it is being written. The
// chmod covers container images that ignore `ownerOnly`.
async function writeOwnerOnlyFile(
  host: S3FSHost,
  operation: string,
  path: string,
  content: string
): Promise<void> {
  await host.runRuntimeCall(`mount.s3fs.write${operation}`, (control) =>
    control.files.writeFile(path, content, { ownerOnly: true })
  );
  await host.runRuntimeCall(`mount.s3fs.chmod${operation}`, (control) =>
    control.mounts.chmodOwnerOnly(path)
  );
}

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
  await writeOwnerOnlyFile(
    host,
    'HeaderFile',
    headerFilePath,
    S3FS_DISABLE_EXPECT_HEADER_CONFIG
  );
}

export async function createPasswordFile(
  host: S3FSHost,
  passwordFilePath: string,
  bucket: string,
  credentials: BucketCredentials
): Promise<void> {
  const content = `${bucket}:${credentials.accessKeyId}:${credentials.secretAccessKey}`;
  await writeOwnerOnlyFile(host, 'PasswordFile', passwordFilePath, content);
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
