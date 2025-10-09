/**
 * File streaming utilities for reading binary and text files
 * Provides simple AsyncIterable API over SSE stream with automatic base64 decoding
 */

import { parseSSEStream } from './sse-parser';
import type { FileChunk, FileMetadata, FileStreamEvent } from './types';

/**
 * Convert ReadableStream of SSE file events to AsyncIterable of file chunks
 * Automatically decodes base64 for binary files and provides metadata
 *
 * @param stream - The SSE ReadableStream from readFileStream()
 * @param signal - Optional AbortSignal for cancellation
 * @returns AsyncIterable that yields file chunks (string for text, Uint8Array for binary)
 *
 * @example
 * ```typescript
 * const stream = await sandbox.readFileStream('/path/to/file.png');
 *
 * for await (const chunk of streamFile(stream)) {
 *   if (chunk instanceof Uint8Array) {
 *     // Binary chunk - already decoded from base64
 *     console.log('Binary chunk:', chunk.byteLength, 'bytes');
 *   } else {
 *     // Text chunk
 *     console.log('Text chunk:', chunk);
 *   }
 * }
 *
 * // Access metadata
 * const iter = streamFile(stream);
 * for await (const chunk of iter) {
 *   console.log('MIME type:', iter.metadata?.mimeType);
 *   // process chunk...
 * }
 * ```
 */
export async function* streamFile(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<FileChunk, void, undefined> {
  let metadata: FileMetadata | undefined;

  try {
    for await (const event of parseSSEStream<FileStreamEvent>(stream, signal)) {
      switch (event.type) {
        case 'metadata':
          // Store metadata for access via iterator
          metadata = {
            mimeType: event.mimeType,
            size: event.size,
            isBinary: event.isBinary,
            encoding: event.encoding,
          };
          // Store on generator function for external access
          (streamFile as any).metadata = metadata;
          break;

        case 'chunk':
          // Auto-decode base64 for binary files
          if (metadata?.isBinary && metadata?.encoding === 'base64') {
            // Decode base64 to Uint8Array
            const binaryString = atob(event.data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            yield bytes;
          } else {
            // Text file - yield as-is
            yield event.data;
          }
          break;

        case 'complete':
          // Stream completed successfully
          console.log(`[streamFile] File streaming complete: ${event.bytesRead} bytes read`);
          return;

        case 'error':
          // Stream error
          throw new Error(`File streaming error: ${event.error}`);
      }
    }
  } catch (error) {
    console.error('[streamFile] Error streaming file:', error);
    throw error;
  }
}

/**
 * Helper to collect entire file from stream into memory
 * Useful for smaller files where you want the complete content at once
 *
 * @param stream - The SSE ReadableStream from readFileStream()
 * @param signal - Optional AbortSignal for cancellation
 * @returns Object with content (string or Uint8Array) and metadata
 *
 * @example
 * ```typescript
 * const stream = await sandbox.readFileStream('/path/to/image.png');
 * const { content, metadata } = await collectFile(stream);
 *
 * if (content instanceof Uint8Array) {
 *   console.log('Binary file:', metadata.mimeType, content.byteLength, 'bytes');
 * } else {
 *   console.log('Text file:', metadata.mimeType, content.length, 'chars');
 * }
 * ```
 */
export async function collectFile(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<{ content: string | Uint8Array; metadata: FileMetadata }> {
  let metadata: FileMetadata | undefined;
  const chunks: FileChunk[] = [];

  for await (const chunk of streamFile(stream, signal)) {
    chunks.push(chunk);
    // Capture metadata from first iteration
    if (!metadata && (streamFile as any).metadata) {
      metadata = (streamFile as any).metadata;
    }
  }

  if (!metadata) {
    throw new Error('No metadata received from file stream');
  }

  // Combine chunks based on type
  if (chunks.length === 0) {
    // Empty file
    return {
      content: metadata.isBinary ? new Uint8Array(0) : '',
      metadata,
    };
  }

  // Check if binary or text based on first chunk
  if (chunks[0] instanceof Uint8Array) {
    // Binary file - concatenate Uint8Arrays
    const totalLength = chunks.reduce((sum, chunk) => {
      return sum + (chunk as Uint8Array).byteLength;
    }, 0);

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk as Uint8Array, offset);
      offset += (chunk as Uint8Array).byteLength;
    }

    return { content: result, metadata };
  } else {
    // Text file - concatenate strings
    return {
      content: chunks.join(''),
      metadata,
    };
  }
}
