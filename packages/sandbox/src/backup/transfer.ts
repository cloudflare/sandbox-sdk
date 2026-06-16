import type { ExecOptions, ExecResult } from '@repo/shared';
import { type createLogger, getEnvString, shellEscape } from '@repo/shared';
import { AwsClient } from 'aws4fetch';
import type { ContainerControlClient } from '../container-control';
import {
  BackupCreateError,
  BackupRestoreError,
  ErrorCode,
  InvalidBackupConfigError,
  SandboxError
} from '../errors';
import { isR2Bucket } from '../storage-mount';
import {
  BACKUP_CONTAINER_DIR,
  BACKUP_DOWNLOAD_MAX_PARTS,
  BACKUP_DOWNLOAD_PARALLEL_MIN_SIZE,
  BACKUP_DOWNLOAD_PARALLEL_PARTS,
  BACKUP_MULTIPART_MAX_PARTS,
  BACKUP_MULTIPART_MIN_PART_SIZE,
  BACKUP_MULTIPART_TARGET_PARTS,
  calculatePartCount
} from './constants';

type BackupTransferDeps = {
  getEnv: () => unknown;
  getClient: () => ContainerControlClient;
  logger: ReturnType<typeof createLogger>;
  execWithSession: (
    command: string,
    sessionId: string,
    options?: ExecOptions
  ) => Promise<ExecResult>;
};

export class BackupTransfer {
  private static readonly PRESIGNED_URL_EXPIRY_SECONDS = 3600;

  constructor(private readonly deps: BackupTransferDeps) {
    this.parseBackupBucketEndpoint(this.env as Record<string, unknown>);
  }

  private get env(): unknown {
    return this.deps.getEnv();
  }

  private get client(): ContainerControlClient {
    return this.deps.getClient();
  }

  private execWithSession(
    command: string,
    sessionId: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    return this.deps.execWithSession(command, sessionId, options);
  }

  private parseBackupBucketEndpoint(
    envObj: Record<string, unknown>
  ): string | null {
    const rawEndpoint = getEnvString(envObj, 'BACKUP_BUCKET_ENDPOINT') ?? null;
    if (rawEndpoint === null) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawEndpoint);
    } catch {
      const msg = `BACKUP_BUCKET_ENDPOINT is not a valid URL: "${rawEndpoint}". Expected format: https://<account_id>.eu.r2.cloudflarestorage.com`;
      throw new InvalidBackupConfigError({
        message: msg,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: msg },
        timestamp: new Date().toISOString()
      });
    }
    if (parsed.protocol !== 'https:') {
      const msg = `BACKUP_BUCKET_ENDPOINT must use https://, got "${parsed.protocol.slice(0, -1)}://"`;
      throw new InvalidBackupConfigError({
        message: msg,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: msg },
        timestamp: new Date().toISOString()
      });
    }
    if (parsed.pathname !== '/') {
      const msg = `BACKUP_BUCKET_ENDPOINT must not include a path (got "${parsed.pathname}"). Provide only the origin, e.g. https://<account_id>.eu.r2.cloudflarestorage.com`;
      throw new InvalidBackupConfigError({
        message: msg,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: msg },
        timestamp: new Date().toISOString()
      });
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      const msg =
        'BACKUP_BUCKET_ENDPOINT must not include query parameters or fragments. Provide only the origin, e.g. https://<account_id>.eu.r2.cloudflarestorage.com';
      throw new InvalidBackupConfigError({
        message: msg,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: msg },
        timestamp: new Date().toISOString()
      });
    }
    return parsed.origin;
  }

  /** Validate that the BACKUP_BUCKET R2 binding is present and return it. */
  requireBackupBucket(): R2Bucket {
    const bucket = (this.env as Record<string, unknown>).BACKUP_BUCKET;
    if (!isR2Bucket(bucket)) {
      throw new InvalidBackupConfigError({
        message:
          'Backup not configured. Add a BACKUP_BUCKET R2 binding to your wrangler.jsonc.',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'Missing BACKUP_BUCKET R2 binding' },
        timestamp: new Date().toISOString()
      });
    }
    return bucket;
  }

  requirePresignedURLSupport(): {
    client: AwsClient;
    accountId: string;
    bucketName: string;
  } {
    const envObj = this.env as Record<string, unknown>;
    const r2AccountId =
      getEnvString(envObj, 'CLOUDFLARE_R2_ACCOUNT_ID') ??
      getEnvString(envObj, 'CLOUDFLARE_ACCOUNT_ID') ??
      null;
    const r2AccessKeyId = getEnvString(envObj, 'R2_ACCESS_KEY_ID') ?? null;
    const r2SecretAccessKey =
      getEnvString(envObj, 'R2_SECRET_ACCESS_KEY') ?? null;
    const backupBucketName = getEnvString(envObj, 'BACKUP_BUCKET_NAME') ?? null;

    if (
      !r2AccessKeyId ||
      !r2SecretAccessKey ||
      !r2AccountId ||
      !backupBucketName
    ) {
      const missing: string[] = [];
      if (!r2AccountId)
        missing.push('CLOUDFLARE_R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID');
      if (!r2AccessKeyId) missing.push('R2_ACCESS_KEY_ID');
      if (!r2SecretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
      if (!backupBucketName) missing.push('BACKUP_BUCKET_NAME');

      throw new InvalidBackupConfigError({
        message:
          `Backup requires R2 presigned URL credentials. ` +
          `Missing: ${missing.join(', ')}. ` +
          'Set these as environment variables or secrets in your wrangler.jsonc.',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: `Missing env vars: ${missing.join(', ')}` },
        timestamp: new Date().toISOString()
      });
    }

    return {
      client: new AwsClient({
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey
      }),
      accountId: r2AccountId,
      bucketName: backupBucketName
    };
  }

  private getBackupBucketEndpoint(accountId: string): string {
    return (
      this.parseBackupBucketEndpoint(this.env as Record<string, unknown>) ??
      `https://${accountId}.r2.cloudflarestorage.com`
    );
  }

  getBackupObjectURL(
    accountId: string,
    bucketName: string,
    r2Key: string
  ): URL {
    const encodedBucket = encodeURIComponent(bucketName);
    const encodedKey = r2Key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');

    return new URL(
      `${this.getBackupBucketEndpoint(accountId)}/${encodedBucket}/${encodedKey}`
    );
  }

  /**
   * Generate a presigned GET URL for downloading an object from R2.
   * The container can curl this URL directly without credentials.
   */
  async generatePresignedGetURL(r2Key: string): Promise<string> {
    const { client, accountId, bucketName } = this.requirePresignedURLSupport();

    const url = this.getBackupObjectURL(accountId, bucketName, r2Key);
    url.searchParams.set(
      'X-Amz-Expires',
      String(BackupTransfer.PRESIGNED_URL_EXPIRY_SECONDS)
    );

    const signed = await client.sign(new Request(url), {
      aws: { signQuery: true }
    });

    return signed.url;
  }

  /**
   * Generate a presigned PUT URL for uploading an object to R2.
   * The container can curl PUT to this URL directly without credentials.
   */
  private async generatePresignedPutURL(r2Key: string): Promise<string> {
    const { client, accountId, bucketName } = this.requirePresignedURLSupport();

    const url = this.getBackupObjectURL(accountId, bucketName, r2Key);
    url.searchParams.set(
      'X-Amz-Expires',
      String(BackupTransfer.PRESIGNED_URL_EXPIRY_SECONDS)
    );

    const signed = await client.sign(new Request(url, { method: 'PUT' }), {
      aws: { signQuery: true }
    });

    return signed.url;
  }

  /**
   * Upload a backup archive via presigned PUT URL.
   * The container curls the archive directly to R2, bypassing the DO.
   * ~24 MB/s throughput vs ~0.6 MB/s for base64 readFile.
   */
  async uploadBackupPresigned(
    archivePath: string,
    r2Key: string,
    archiveSize: number,
    backupId: string,
    dir: string,
    backupSession: string
  ): Promise<void> {
    const presignedURL = await this.generatePresignedPutURL(r2Key);

    const curlCmd = [
      'curl -sSf',
      '-X PUT',
      "-H 'Content-Type: application/octet-stream'",
      '--connect-timeout 10',
      '--max-time 1800',
      '--retry 2',
      '--retry-max-time 60',
      `-T ${shellEscape(archivePath)}`,
      shellEscape(presignedURL)
    ].join(' ');

    const result = await this.execWithSession(curlCmd, backupSession, {
      timeout: 1810_000,
      origin: 'internal'
    });

    if (result.exitCode !== 0) {
      throw new BackupCreateError({
        message: `Presigned URL upload failed (exit code ${result.exitCode}): ${result.stderr}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    // Verify the upload landed correctly in R2
    const bucket = this.requireBackupBucket();
    const head = await bucket.head(r2Key);
    if (!head || head.size !== archiveSize) {
      const actualSize = head?.size ?? 0;
      // curl succeeded but R2 binding sees nothing — almost certainly a
      // local-dev mismatch where presigned URLs target real R2 while the
      // BACKUP_BUCKET binding points to local (miniflare) storage.
      const localDevHint =
        result.exitCode === 0 && actualSize === 0
          ? ' This usually means the BACKUP_BUCKET R2 binding is using local storage ' +
            'while presigned URLs upload to remote R2. Add `"remote": true` to your ' +
            'BACKUP_BUCKET R2 binding in wrangler.jsonc to fix this.'
          : '';
      throw new BackupCreateError({
        message: `Upload verification failed: expected ${archiveSize} bytes, got ${actualSize}.${localDevHint}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Generate a presigned PUT URL for a single part in a multipart upload.
   */
  private async generatePresignedPartURL(
    r2Key: string,
    uploadId: string,
    partNumber: number
  ): Promise<string> {
    const { client, accountId, bucketName } = this.requirePresignedURLSupport();

    const url = this.getBackupObjectURL(accountId, bucketName, r2Key);
    url.searchParams.set(
      'X-Amz-Expires',
      String(BackupTransfer.PRESIGNED_URL_EXPIRY_SECONDS)
    );
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);

    const signed = await client.sign(new Request(url, { method: 'PUT' }), {
      aws: { signQuery: true }
    });

    return signed.url;
  }

  /**
   * Upload a backup archive to R2 using parallel multipart upload.
   * Uses the S3-compatible API exclusively for create/complete/abort so that
   * the uploadId is in the same namespace as the presigned part PUT URLs.
   */
  async uploadBackupMultipart(
    archivePath: string,
    r2Key: string,
    sizeBytes: number,
    backupId: string,
    dir: string,
    backupSession: string
  ): Promise<void> {
    const targetParts = calculatePartCount(
      sizeBytes,
      BACKUP_MULTIPART_TARGET_PARTS,
      BACKUP_MULTIPART_MAX_PARTS
    );
    const numParts = Math.min(
      targetParts,
      Math.floor(sizeBytes / BACKUP_MULTIPART_MIN_PART_SIZE)
    );

    if (numParts <= 1) {
      return this.uploadBackupPresigned(
        archivePath,
        r2Key,
        sizeBytes,
        backupId,
        dir,
        backupSession
      );
    }

    const { client, accountId, bucketName } = this.requirePresignedURLSupport();
    const objectURL = this.getBackupObjectURL(
      accountId,
      bucketName,
      r2Key
    ).toString();

    const createResp = await client.fetch(`${objectURL}?uploads`, {
      method: 'POST'
    });
    if (!createResp.ok) {
      throw new BackupCreateError({
        message: `Failed to initiate multipart upload: HTTP ${createResp.status}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    const createXml = await createResp.text();
    const uploadIdMatch = createXml.match(/<UploadId>([^<]+)<\/UploadId>/);
    const uploadId = uploadIdMatch?.[1];
    if (!uploadId) {
      throw new BackupCreateError({
        message: 'Multipart upload response did not contain an UploadId',
        code: ErrorCode.BACKUP_CREATE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    const abortMultipart = async () => {
      await client
        .fetch(`${objectURL}?uploadId=${encodeURIComponent(uploadId)}`, {
          method: 'DELETE'
        })
        .catch(() => {});
    };

    try {
      const partSize = Math.ceil(sizeBytes / numParts);
      const parts = await Promise.all(
        Array.from({ length: numParts }, (_, i) => ({
          partNumber: i + 1,
          url: '',
          offset: i * partSize,
          size: i === numParts - 1 ? sizeBytes - i * partSize : partSize
        })).map(async (part) => ({
          ...part,
          url: await this.generatePresignedPartURL(
            r2Key,
            uploadId,
            part.partNumber
          )
        }))
      );

      let uploadResult: Awaited<
        ReturnType<typeof this.client.backup.uploadParts>
      >;
      try {
        uploadResult = await this.client.backup.uploadParts({
          archivePath,
          parts,
          sessionId: backupSession
        });
      } catch (err) {
        if (
          err instanceof SandboxError &&
          err.errorResponse.httpStatus === 404
        ) {
          await abortMultipart();
          return this.uploadBackupPresigned(
            archivePath,
            r2Key,
            sizeBytes,
            backupId,
            dir,
            backupSession
          );
        }
        throw err;
      }

      if (!uploadResult.success || uploadResult.parts.length !== numParts) {
        throw new BackupCreateError({
          message: `Multipart upload returned ${uploadResult.parts.length} of ${numParts} parts`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }

      const completeXml = [
        '<CompleteMultipartUpload>',
        ...uploadResult.parts.map(
          (p: { partNumber: number; etag: string }) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`
        ),
        '</CompleteMultipartUpload>'
      ].join('');

      const completeResp = await client.fetch(
        `${objectURL}?uploadId=${encodeURIComponent(uploadId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml' },
          body: completeXml
        }
      );

      if (!completeResp.ok) {
        const body = await completeResp.text().catch(() => '');
        throw new BackupCreateError({
          message: `Multipart upload completion failed: HTTP ${completeResp.status} ${body}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }

      const head = await this.requireBackupBucket().head(r2Key);
      if (!head || head.size !== sizeBytes) {
        throw new BackupCreateError({
          message: `Multipart upload verification failed: expected ${sizeBytes} bytes, got ${head?.size ?? 0}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      await abortMultipart();
      throw error;
    }
  }

  /**
   * Download a backup archive from R2 via presigned GET URL.
   * For archives >= BACKUP_DOWNLOAD_PARALLEL_MIN_SIZE, uses BACKUP_DOWNLOAD_PARALLEL_PARTS
   * concurrent curl processes (each downloading a byte-range) to maximise both
   * network and disk-write throughput. Parts are written into a pre-sized file
   * with dd using byte offsets, then atomically moved to the final path.
   */
  async downloadBackupParallel(
    archivePath: string,
    r2Key: string,
    expectedSize: number,
    backupId: string,
    dir: string,
    backupSession: string
  ): Promise<void> {
    const presignedURL = await this.generatePresignedGetURL(r2Key);
    await this.execWithSession(
      `mkdir -p ${BACKUP_CONTAINER_DIR}`,
      backupSession,
      { origin: 'internal' }
    );

    const tmpPath = `${archivePath}.tmp`;

    if (expectedSize < BACKUP_DOWNLOAD_PARALLEL_MIN_SIZE) {
      const curlCmd = [
        'curl -sSf',
        '--connect-timeout 10',
        '--max-time 1800',
        '--retry 2',
        '--retry-max-time 60',
        `-o ${shellEscape(tmpPath)}`,
        shellEscape(presignedURL)
      ].join(' ');

      const result = await this.execWithSession(curlCmd, backupSession, {
        timeout: 1810_000,
        origin: 'internal'
      });

      if (result.exitCode !== 0) {
        await this.execWithSession(
          `rm -f ${shellEscape(tmpPath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        throw new BackupRestoreError({
          message: `Presigned URL download failed (exit code ${result.exitCode}): ${result.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }
    } else {
      const numParts = calculatePartCount(
        expectedSize,
        BACKUP_DOWNLOAD_PARALLEL_PARTS,
        BACKUP_DOWNLOAD_MAX_PARTS
      );
      const partSize = Math.floor(expectedSize / numParts);
      const ranges = Array.from({ length: numParts }, (_, i) => {
        const start = i * partSize;
        const end = i < numParts - 1 ? start + partSize - 1 : expectedSize - 1;
        return { start, range: `${start}-${end}` };
      });

      const curlCmds = ranges.map(({ start, range }) =>
        [
          'curl -sSf',
          '--connect-timeout 10',
          '--max-time 1800',
          `-H ${shellEscape(`Range: bytes=${range}`)}`,
          shellEscape(presignedURL),
          '|',
          'dd',
          `of=${shellEscape(tmpPath)}`,
          'oflag=seek_bytes',
          `seek=${start}`,
          'conv=notrunc',
          '2>/dev/null'
        ].join(' ')
      );

      const startLines = curlCmds.map(
        (cmd, i) => `(set -o pipefail; ${cmd}) & J${i}=$!`
      );
      const waitLines = Array.from(
        { length: numParts },
        (_, i) => `wait $J${i}; E${i}=$?`
      );
      const exitVars = Array.from({ length: numParts }, (_, i) => `$E${i}`);

      const script = [
        `rm -f ${shellEscape(tmpPath)}`,
        `truncate -s ${expectedSize} ${shellEscape(tmpPath)}`,
        ...startLines,
        ...waitLines,
        `FAILED=$(( ${exitVars.join(' + ')} ))`,
        `if [ "$FAILED" -ne 0 ]; then rm -f ${shellEscape(tmpPath)}; exit 1; fi`
      ].join('; ');

      const result = await this.execWithSession(script, backupSession, {
        timeout: 1810_000,
        origin: 'internal'
      });

      if (result.exitCode !== 0) {
        await this.execWithSession(
          `rm -f ${shellEscape(tmpPath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        throw new BackupRestoreError({
          message: `Parallel download failed (exit code ${result.exitCode}): ${result.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId },
          timestamp: new Date().toISOString()
        });
      }
    }

    const sizeCheck = await this.execWithSession(
      `stat -c %s ${shellEscape(tmpPath)}`,
      backupSession,
      { origin: 'internal' }
    );
    const actualSize = parseInt(sizeCheck.stdout.trim(), 10);
    if (actualSize !== expectedSize) {
      await this.execWithSession(
        `rm -f ${shellEscape(tmpPath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});
      throw new BackupRestoreError({
        message: `Downloaded archive size mismatch: expected ${expectedSize}, got ${actualSize}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }

    const mvResult = await this.execWithSession(
      `mv ${shellEscape(tmpPath)} ${shellEscape(archivePath)}`,
      backupSession,
      { origin: 'internal' }
    );
    if (mvResult.exitCode !== 0) {
      await this.execWithSession(
        `rm -f ${shellEscape(tmpPath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});
      throw new BackupRestoreError({
        message: `Failed to finalize downloaded archive: ${mvResult.stderr}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        httpStatus: 500,
        context: { dir, backupId },
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Serialize backup operations on this sandbox instance.
   * Concurrent backup/restore calls are queued so the multi-step
   * create-archive → read → upload (or mount → extract) flow
   * is not interleaved with another backup operation on the same directory.
   */
}
