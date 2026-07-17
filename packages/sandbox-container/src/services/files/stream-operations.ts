import { chmod, rename, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FileInfo, ListFilesOptions, Logger } from '@repo/shared';
import { logCanonicalEvent, shellEscape } from '@repo/shared';
import type {
  FileNotFoundContext,
  FileSystemContext,
  FileTooLargeContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode, Operation } from '@repo/shared/errors';
import {
  type FileMetadata,
  type FileStats,
  type MkdirOptions,
  type ReadOptions,
  type ServiceError,
  type ServiceResult,
  serviceError,
  serviceSuccess,
  type WriteOptions
} from '../../core/types';
import { FileArchiveOperations } from './archive-operations';

export class FileStreamOperations extends FileArchiveOperations {
  async readFileStreamOperation(
    path: string
  ): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const validation = this.security.validatePath(path);
    if (!validation.isValid) {
      return new ReadableStream({
        start(controller) {
          const errorEvent = {
            type: 'error',
            error: `Invalid path format for '${path}': ${validation.errors.join(
              ', '
            )}`
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
          controller.close();
        }
      });
    }

    const CHUNK_SIZE = 65535;

    return await this.withExecutionInternal(async (exec) => {
      const absolutePath = await this.resolvePathInExecutionContext(path, exec);
      const metadataResult = await this.getFileMetadata(absolutePath, exec);

      if (!metadataResult.success) {
        return new ReadableStream({
          start(controller) {
            const errorEvent = {
              type: 'error',
              error: metadataResult.error.message
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
            );
            controller.close();
          }
        });
      }

      const metadata = metadataResult.data;

      const fileStream = Bun.file(absolutePath).stream();

      // Carry-over buffer for chunks that arrive smaller than CHUNK_SIZE from
      // Bun's internal read buffer so we always emit full-sized SSE events.
      let carry = new Uint8Array(0);
      let totalBytesEmitted = 0;

      const sseTransform = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          // Emit the metadata SSE event as the very first bytes of the stream.
          const metadataEvent = {
            type: 'metadata',
            mimeType: metadata.mimeType,
            size: metadata.size,
            isBinary: metadata.isBinary,
            encoding: metadata.encoding
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(metadataEvent)}\n\n`)
          );
        },

        transform(incoming, controller) {
          const combined = new Uint8Array(carry.length + incoming.length);
          combined.set(carry);
          combined.set(incoming, carry.length);

          let offset = 0;
          while (offset + CHUNK_SIZE <= combined.length) {
            const slice = combined.subarray(offset, offset + CHUNK_SIZE);
            emitChunk(
              slice,
              metadata.isBinary,
              encoder,
              decoder,
              controller,
              true
            );
            totalBytesEmitted += slice.length;
            offset += CHUNK_SIZE;
          }

          carry = combined.subarray(offset);
        },

        flush(controller) {
          if (carry.length > 0) {
            emitChunk(
              carry,
              metadata.isBinary,
              encoder,
              decoder,
              controller,
              false
            );
            totalBytesEmitted += carry.length;
            carry = new Uint8Array(0);
          }
          if (!metadata.isBinary) {
            const remaining = decoder.decode();
            if (remaining.length > 0) {
              const chunkEvent = { type: 'chunk', data: remaining };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunkEvent)}\n\n`)
              );
            }
          }

          const completeEvent = {
            type: 'complete',
            bytesRead: totalBytesEmitted
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(completeEvent)}\n\n`)
          );
        }
      });

      return fileStream.pipeThrough(sseTransform);
    }).then((result) => {
      if (!result.success) {
        throw new Error(
          `Failed to create file stream: ${result.error.message}`
        );
      }
      return result.data;
    });
  }

  /**
   * Stream raw binary file contents without SSE framing or base64 encoding.
   * The stream passes directly to the caller over the capnp binary channel.
   *
   * Validates the path, resolves relative paths via the execution context, then
   * returns Bun's native file stream alongside the file size and MIME type.
   *
   * Returns a `ServiceResult` so callers receive typed `ErrorCode` values
   * (e.g. `FILE_NOT_FOUND`, `VALIDATION_FAILED`) rather than plain throws.
   */
  async readFileBinaryStream(path: string): Promise<
    ServiceResult<{
      content: ReadableStream<Uint8Array>;
      size: number;
      mimeType: string;
    }>
  > {
    // Validate path for security.
    const validation = this.security.validatePath(path);
    if (!validation.isValid) {
      return {
        success: false,
        error: {
          message: `Invalid path format for '${path}': ${validation.errors.join(', ')}`,
          code: ErrorCode.VALIDATION_FAILED,
          details: {
            validationErrors: validation.errors.map((e) => ({
              field: 'path',
              message: e,
              code: 'INVALID_PATH'
            }))
          } satisfies ValidationFailedContext
        }
      };
    }

    // Resolve relative paths via the execution context.
    let resolvedPath = path;
    if (!path.startsWith('/')) {
      const result = await this.withExecutionInternal(async (exec) =>
        this.resolvePathInExecutionContext(path, exec)
      );
      if (!result.success) {
        return {
          success: false,
          error: {
            message: `Failed to resolve path '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: 'execution context failed'
            } satisfies FileSystemContext
          }
        };
      }
      resolvedPath = result.data as string;
    }

    // Check existence and return the stream.
    const file = Bun.file(resolvedPath);
    const exists = await file.exists();
    if (!exists) {
      return {
        success: false,
        error: {
          message: `File not found: ${resolvedPath}`,
          code: ErrorCode.FILE_NOT_FOUND,
          details: {
            path: resolvedPath,
            operation: Operation.FILE_READ
          } satisfies FileNotFoundContext
        }
      };
    }

    return {
      success: true,
      data: {
        content: file.stream(),
        size: file.size,
        mimeType: file.type || 'application/octet-stream'
      }
    };
  }
}

/**
 * Encode a byte slice as an SSE chunk event and enqueue it onto the
 * TransformStream controller.  Binary slices are base64-encoded; text slices
 * are UTF-8 decoded and embedded as-is.
 */
function emitChunk(
  slice: Uint8Array,
  isBinary: boolean,
  encoder: TextEncoder,
  decoder: TextDecoder,
  controller: TransformStreamDefaultController<Uint8Array>,
  stream: boolean
): void {
  let data: string;
  if (isBinary) {
    // Encode bytes to base64 without line breaks.
    data = Buffer.from(slice).toString('base64');
  } else {
    data = decoder.decode(slice, { stream });
  }

  const chunkEvent = { type: 'chunk', data };
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkEvent)}\n\n`));
}
