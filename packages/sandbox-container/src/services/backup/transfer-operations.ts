import type { Logger } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import {
  type ServiceError,
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../../core/types';
import type { CommandContextService } from '../command-context-service';
import type { InternalCommandResult } from '../internal-command-result';
import {
  BACKUP_UPLOAD_MAX_ATTEMPTS,
  BACKUP_UPLOAD_TIMEOUT_MS,
  BACKUP_WORK_DIR,
  type BackupUploadPart,
  type UploadedBackupPart,
  validateArchivePath
} from './archive-operations';

class NonRetryableUploadPartError extends Error {}

type DownloadPart = { url: string; offset: number; range?: string };

function parseRange(range: string): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return undefined;
  }
  return { start, end };
}

function validateDownloadCoverage(
  expectedSize: number,
  parts: DownloadPart[]
): string | undefined {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    return 'Invalid download request: expectedSize must be a finite nonnegative integer';
  }
  if (parts.length === 0) {
    return 'Invalid download request: at least one part is required';
  }

  if (parts.length === 1 && parts[0].range === undefined) {
    return parts[0].offset === 0 && Number.isSafeInteger(parts[0].offset)
      ? undefined
      : 'Invalid download request: single full-object download must start at offset 0';
  }

  const sortedParts = [...parts].sort((a, b) => a.offset - b.offset);
  let nextOffset = 0;
  for (const part of sortedParts) {
    if (!Number.isSafeInteger(part.offset) || part.offset < 0) {
      return 'Invalid download request: part offsets must be finite nonnegative integers';
    }
    const range = part.range ? parseRange(part.range) : undefined;
    if (!range) {
      return 'Invalid download request: ranged multipart downloads must include valid byte ranges';
    }
    if (range.start !== part.offset) {
      return 'Invalid download request: part offset must match range start';
    }
    if (range.end < range.start) {
      return 'Invalid download request: byte ranges must be non-empty and ordered';
    }
    const endExclusive = range.end + 1;
    if (part.offset !== nextOffset) {
      return 'Invalid download request: parts must exactly cover the archive without holes or overlaps';
    }
    if (endExclusive > expectedSize) {
      return 'Invalid download request: byte ranges must not exceed expectedSize';
    }
    nextOffset = endExclusive;
  }

  if (nextOffset !== expectedSize) {
    return 'Invalid download request: parts must exactly cover expectedSize';
  }
  return undefined;
}

export class TransferOperations {
  constructor(
    private logger: Logger,
    private commandContextService: CommandContextService
  ) {}

  private async executeInternal(
    command: string,
    options: { timeoutMs?: number } = {}
  ): Promise<ServiceResult<InternalCommandResult>> {
    try {
      const result = await this.commandContextService.run(command, {
        timeoutMs: options.timeoutMs
      });
      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        error: this.toServiceError(error)
      };
    }
  }

  private toServiceError(error: unknown): ServiceError {
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      code: ErrorCode.INTERNAL_ERROR
    };
  }

  private async uploadPart(
    archiveFile: ReturnType<typeof Bun.file>,
    part: BackupUploadPart
  ): Promise<UploadedBackupPart> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= BACKUP_UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const body = archiveFile.slice(part.offset, part.offset + part.size);
        const response = await fetch(part.url, {
          method: 'PUT',
          headers: {
            'Content-Length': String(part.size),
            'Content-Type': 'application/octet-stream'
          },
          body,
          signal: AbortSignal.timeout(BACKUP_UPLOAD_TIMEOUT_MS)
        });

        if (!response.ok) {
          throw new Error(
            `part ${part.partNumber} failed with HTTP ${response.status}`
          );
        }

        const etag = response.headers.get('etag')?.trim();
        if (!etag) {
          throw new NonRetryableUploadPartError(
            `part ${part.partNumber} response did not include an ETag header`
          );
        }

        return {
          partNumber: part.partNumber,
          etag
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (error instanceof NonRetryableUploadPartError) {
          throw err;
        }
        lastError = err;
        if (attempt < BACKUP_UPLOAD_MAX_ATTEMPTS) {
          this.logger.warn(
            `backup upload part ${part.partNumber} failed on attempt ${attempt}, retrying`,
            { error: err.message }
          );
        }
      }
    }

    throw lastError ?? new Error(`part ${part.partNumber} failed`);
  }

  /**
   * Upload parts of a backup archive to presigned URLs in parallel.
   * The caller (DO) has already created a multipart upload and generated
   * presigned PUT URLs for each part. This method uploads each byte range
   * directly from the local archive using concurrent PUT requests.
   */
  async uploadParts(
    archivePath: string,
    parts: BackupUploadPart[]
  ): Promise<ServiceResult<{ parts: UploadedBackupPart[] }>> {
    if (parts.length === 0) {
      return serviceSuccess({ parts: [] });
    }

    const archivePathError = validateArchivePath(archivePath);
    if (archivePathError) {
      return serviceError({
        message: archivePathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { archivePath }
      });
    }

    const archiveFile = Bun.file(archivePath);
    if (!(await archiveFile.exists())) {
      return serviceError({
        message: `Backup archive does not exist: ${archivePath}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        details: { archivePath }
      });
    }

    let uploadedParts: UploadedBackupPart[];
    try {
      uploadedParts = await Promise.all(
        parts.map((part) => this.uploadPart(archiveFile, part))
      );
    } catch (error) {
      return serviceError({
        message: `Multipart upload failed: ${error instanceof Error ? error.message : String(error)}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        details: { archivePath }
      });
    }

    uploadedParts.sort((a, b) => a.partNumber - b.partNumber);

    return serviceSuccess({ parts: uploadedParts });
  }

  async uploadArchive(request: {
    archivePath: string;
    url: string;
    timeoutMs: number;
  }): Promise<ServiceResult<void>> {
    const archivePathError = validateArchivePath(request.archivePath);
    if (archivePathError) {
      return serviceError({
        message: archivePathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { archivePath: request.archivePath }
      });
    }
    const result = await this.executeInternal(
      `curl -f -sS -X PUT --data-binary @${shellEscape(request.archivePath)} ${shellEscape(request.url)}`,
      { timeoutMs: request.timeoutMs }
    );
    if (!result.success || result.data.exitCode !== 0) {
      return serviceError({
        message: `Backup upload failed: ${result.success ? result.data.stderr || result.data.stdout : result.error.message}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        details: { archivePath: request.archivePath }
      });
    }
    return serviceSuccess(undefined);
  }

  async downloadArchive(request: {
    archivePath: string;
    expectedSize: number;
    parts: Array<{ url: string; offset: number; range?: string }>;
    timeoutMs: number;
  }): Promise<ServiceResult<void>> {
    const archivePathError = validateArchivePath(request.archivePath);
    if (archivePathError) {
      return serviceError({
        message: archivePathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { archivePath: request.archivePath }
      });
    }
    const coverageError = validateDownloadCoverage(
      request.expectedSize,
      request.parts
    );
    if (coverageError) {
      return serviceError({
        message: coverageError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { archivePath: request.archivePath }
      });
    }
    const sortedParts = [...request.parts].sort((a, b) => a.offset - b.offset);
    const partCommands = sortedParts
      .map((part, index) => {
        const nextOffset =
          sortedParts[index + 1]?.offset ?? request.expectedSize;
        const expectedBytes = nextOffset - part.offset;
        const range = part.range
          ? ` -H ${shellEscape(`Range: ${part.range}`)}`
          : '';
        return [
          `part_file="$tmp_dir/part-${index}"`,
          `curl -f -sS${range} -o "$part_file" ${shellEscape(part.url)} &`,
          'pids="$pids $!"',
          `part_files="${part.offset}:${expectedBytes}:$part_file
$part_files"`
        ].join('\n');
      })
      .join('\n');
    const command = `set -euo pipefail
mkdir -p ${shellEscape(BACKUP_WORK_DIR)}
tmp_dir=$(mktemp -d ${shellEscape(`${BACKUP_WORK_DIR}/download.XXXXXX`)})
tmp_archive="$tmp_dir/archive"
pids=""
part_files=""
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
${partCommands}
failed=0
for pid in $pids; do
  if ! wait "$pid"; then
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi
truncate -s ${request.expectedSize} "$tmp_archive"
while IFS=: read -r offset expected_bytes part_file; do
  [ -n "$offset" ] || continue
  actual_bytes=$(wc -c < "$part_file")
  if [ "$actual_bytes" -ne "$expected_bytes" ]; then
    echo "downloaded part size mismatch at offset $offset: expected $expected_bytes got $actual_bytes" >&2
    exit 1
  fi
  dd if="$part_file" of="$tmp_archive" bs=1 seek="$offset" conv=notrunc status=none
done <<EOF
$part_files
EOF
actual_size=$(stat -c %s "$tmp_archive")
if [ "$actual_size" -ne ${request.expectedSize} ]; then
  echo "downloaded archive size mismatch: expected ${request.expectedSize} got $actual_size" >&2
  exit 1
fi
mv "$tmp_archive" ${shellEscape(request.archivePath)}
`;
    const result = await this.executeInternal(command, {
      timeoutMs: request.timeoutMs
    });
    if (!result.success || result.data.exitCode !== 0) {
      return serviceError({
        message: `Backup download failed: ${result.success ? result.data.stderr || result.data.stdout : result.error.message}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { archivePath: request.archivePath }
      });
    }
    return serviceSuccess(undefined);
  }

  async cleanupArchive(archivePath: string): Promise<ServiceResult<void>> {
    const archivePathError = validateArchivePath(archivePath);
    if (archivePathError) {
      return serviceError({
        message: archivePathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { archivePath }
      });
    }
    const result = await this.executeInternal(
      `rm -f ${shellEscape(archivePath)}`
    );
    if (!result.success || result.data.exitCode !== 0) {
      return serviceError({
        message: `Failed to clean up backup archive: ${result.success ? result.data.stderr : result.error.message}`,
        code: ErrorCode.INTERNAL_ERROR,
        details: { archivePath }
      });
    }
    return serviceSuccess(undefined);
  }
}
