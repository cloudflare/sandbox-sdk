import {
  type FileChunk,
  type FileMetadata,
  type FileStreamEvent,
  parseSSEFrames,
  type SSEPartialEvent
} from '@repo/shared';

/**
 * Parse SSE (Server-Sent Events) lines from a stream
 */
async function* parseSSE(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<FileStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: SSEPartialEvent = { data: [] };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSSEFrames(buffer, currentEvent);
      buffer = parsed.remaining;
      currentEvent = parsed.currentEvent;

      for (const frame of parsed.events) {
        try {
          const event = JSON.parse(frame.data) as FileStreamEvent;
          yield event;
        } catch {
          // Skip invalid JSON events and continue processing
        }
      }
    }

    // Flush complete frame from final trailing buffer
    const finalParsed = parseSSEFrames(`${buffer}\n\n`, currentEvent);
    for (const frame of finalParsed.events) {
      try {
        const event = JSON.parse(frame.data) as FileStreamEvent;
        yield event;
      } catch {
        // Skip invalid JSON events and continue processing
      }
    }
  } finally {
    // Cancel the stream first to properly terminate HTTP connections when breaking early
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors (stream may already be closed)
    }
    reader.releaseLock();
  }
}

/**
 * Stream a file from the sandbox with automatic base64 decoding for binary files
 *
 * @param stream - The ReadableStream from readFileStream()
 * @returns AsyncGenerator that yields FileChunk (string for text, Uint8Array for binary)
 *
 * @example
 * ```ts
 * const stream = await sandbox.readFileStream('/path/to/file.png');
 * for await (const chunk of streamFile(stream)) {
 *   if (chunk instanceof Uint8Array) {
 *     // Binary chunk
 *     console.log('Binary chunk:', chunk.length, 'bytes');
 *   } else {
 *     // Text chunk
 *     console.log('Text chunk:', chunk);
 *   }
 * }
 * ```
 */
export async function* streamFile(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<FileChunk, FileMetadata> {
  let metadata: FileMetadata | null = null;

  for await (const event of parseSSE(stream)) {
    switch (event.type) {
      case 'metadata':
        metadata = {
          mimeType: event.mimeType,
          size: event.size,
          isBinary: event.isBinary,
          encoding: event.encoding
        };
        break;

      case 'chunk':
        if (!metadata) {
          throw new Error('Received chunk before metadata');
        }

        if (metadata.isBinary && metadata.encoding === 'base64') {
          // Decode base64 to Uint8Array for binary files
          const binaryString = atob(event.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          yield bytes;
        } else {
          // Text files - yield as-is
          yield event.data;
        }
        break;

      case 'complete':
        if (!metadata) {
          throw new Error('Stream completed without metadata');
        }
        return metadata;

      case 'error':
        throw new Error(`File streaming error: ${event.error}`);
    }
  }

  throw new Error('Stream ended unexpectedly');
}

export function abortableByteStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  let released = false;
  let cancellation: Promise<void> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancelSource = async (reason: unknown) => {
    try {
      await reader.cancel(reason);
    } catch {
    } finally {
      release();
    }
  };
  const beginCancellation = (reason: unknown) => {
    cancellation ??= cancelSource(reason);
    return cancellation;
  };
  const abort = () => {
    if (finished) return;
    finished = true;
    void beginCancellation(signal.reason).finally(() => {
      try {
        controller.error(signal.reason);
      } catch {}
    });
  };

  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (signal.aborted) {
          abort();
        } else if (result.done) {
          finished = true;
          signal.removeEventListener('abort', abort);
          release();
          value.close();
        } else {
          value.enqueue(result.value);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        release();
        value.error(error);
      }
    },
    async cancel(reason) {
      if (finished) {
        if (cancellation) await cancellation;
        return;
      }
      finished = true;
      signal.removeEventListener('abort', abort);
      await beginCancellation(reason);
    }
  });
}

export async function* byteChunks(
  chunks: AsyncIterable<string | Uint8Array>
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    if (bytes.byteLength > 0) yield bytes;
  }
}

export async function areByteStreamsEqual(
  left: AsyncIterable<Uint8Array>,
  right: AsyncIterable<Uint8Array>,
  shouldContinue: () => boolean = () => true
): Promise<boolean> {
  const leftIterator = left[Symbol.asyncIterator]();
  const rightIterator = right[Symbol.asyncIterator]();
  let leftChunk: Uint8Array = new Uint8Array(0);
  let rightChunk: Uint8Array = new Uint8Array(0);
  let leftOffset = 0;
  let rightOffset = 0;

  try {
    while (true) {
      if (leftOffset === leftChunk.byteLength) {
        const next = await leftIterator.next();
        if (next.done) {
          if (rightOffset < rightChunk.byteLength) return false;
          while (true) {
            const other = await rightIterator.next();
            if (other.done) return true;
            if (other.value.byteLength > 0) return false;
          }
        }
        leftChunk = next.value;
        leftOffset = 0;
        if (leftChunk.byteLength === 0) continue;
      }
      if (rightOffset === rightChunk.byteLength) {
        const next = await rightIterator.next();
        if (next.done) return false;
        rightChunk = next.value;
        rightOffset = 0;
        if (rightChunk.byteLength === 0) continue;
      }

      if (!shouldContinue()) return false;
      const count = Math.min(
        leftChunk.byteLength - leftOffset,
        rightChunk.byteLength - rightOffset
      );
      for (let index = 0; index < count; index++) {
        if (leftChunk[leftOffset + index] !== rightChunk[rightOffset + index]) {
          return false;
        }
      }
      leftOffset += count;
      rightOffset += count;
    }
  } finally {
    await leftIterator.return?.();
    await rightIterator.return?.();
  }
}

interface UploadByteStreamOptions {
  bucket: R2Bucket;
  key: string;
  chunks: AsyncIterable<string | Uint8Array>;
  partBytes: number;
  expectedETag?: string | null;
  assertCurrent(): void;
}

export async function uploadByteStream({
  bucket,
  key,
  chunks,
  partBytes,
  expectedETag,
  assertCurrent
}: UploadByteStreamOptions): Promise<R2Object | null> {
  const pending: Uint8Array[] = [];
  const parts: R2UploadedPart[] = [];
  let pendingBytes = 0;
  let upload: R2MultipartUpload | null = null;
  const take = (size: number) => {
    const part = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = pending[0];
      const count = Math.min(chunk.byteLength, size - offset);
      part.set(chunk.subarray(0, count), offset);
      offset += count;
      if (count === chunk.byteLength) pending.shift();
      else pending[0] = chunk.subarray(count);
    }
    pendingBytes -= size;
    return part;
  };

  try {
    for await (const bytes of byteChunks(chunks)) {
      assertCurrent();
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      while (pendingBytes >= partBytes) {
        if (!upload) {
          upload = await bucket.createMultipartUpload(key);
          assertCurrent();
        }
        const part = take(partBytes);
        parts.push(await upload.uploadPart(parts.length + 1, part));
        assertCurrent();
      }
    }

    assertCurrent();
    if (upload) {
      if (pendingBytes > 0) {
        parts.push(
          await upload.uploadPart(parts.length + 1, take(pendingBytes))
        );
        assertCurrent();
      }
      assertCurrent();
      return await upload.complete(parts);
    }

    const bytes = take(pendingBytes);
    if (expectedETag === undefined) {
      return await bucket.put(key, bytes);
    }
    const result = await bucket.put(key, bytes, {
      onlyIf:
        expectedETag === null
          ? { etagDoesNotMatch: '*' }
          : { etagMatches: expectedETag }
    });
    return result;
  } catch (error) {
    if (upload) await upload.abort().catch(() => {});
    throw error;
  }
}

/**
 * Collect an entire file into memory from a stream
 *
 * @param stream - The ReadableStream from readFileStream()
 * @returns Object containing the file content and metadata
 *
 * @example
 * ```ts
 * const stream = await sandbox.readFileStream('/path/to/file.txt');
 * const { content, metadata } = await collectFile(stream);
 * console.log('Content:', content);
 * console.log('MIME type:', metadata.mimeType);
 * ```
 */
export async function collectFile(stream: ReadableStream<Uint8Array>): Promise<{
  content: string | Uint8Array;
  metadata: FileMetadata;
}> {
  const chunks: Array<string | Uint8Array> = [];

  // Iterate through the generator and get the return value (metadata)
  const generator = streamFile(stream);
  let result = await generator.next();

  while (!result.done) {
    chunks.push(result.value);
    result = await generator.next();
  }

  const metadata = result.value;

  if (!metadata) {
    throw new Error('Failed to get file metadata');
  }

  // Combine chunks based on type
  if (metadata.isBinary) {
    // Binary file - combine Uint8Arrays
    const totalLength = chunks.reduce(
      (sum, chunk) => sum + (chunk instanceof Uint8Array ? chunk.length : 0),
      0
    );
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      if (chunk instanceof Uint8Array) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
    }
    return { content: combined, metadata };
  } else {
    // Text file - combine strings
    const combined = chunks.filter((c) => typeof c === 'string').join('');
    return { content: combined, metadata };
  }
}
