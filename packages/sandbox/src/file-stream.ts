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
  const { chunks } = await openFileStream(stream);
  return yield* chunks;
}

/**
 * Read the metadata event at the head of a file stream and return it with
 * the decoded chunks that follow. Callers that need the file size before
 * consuming the body, such as sizing a FixedLengthStream, use this instead of
 * streamFile().
 */
export async function openFileStream(
  stream: ReadableStream<Uint8Array>
): Promise<{
  metadata: FileMetadata;
  chunks: AsyncGenerator<FileChunk, FileMetadata>;
}> {
  const events = parseSSE(stream);
  try {
    const first = await events.next();
    if (first.done) {
      throw new Error('Stream ended unexpectedly');
    }
    const metadata = readMetadataEvent(first.value);
    return { metadata, chunks: decodeChunks(events, metadata) };
  } catch (error) {
    // Cancel the underlying stream when the head of it is unusable.
    await events.return(undefined);
    throw error;
  }
}

function readMetadataEvent(event: FileStreamEvent): FileMetadata {
  switch (event.type) {
    case 'metadata':
      return toFileMetadata(event);
    case 'chunk':
      throw new Error('Received chunk before metadata');
    case 'complete':
      throw new Error('Stream completed without metadata');
    case 'error':
      throw new Error(`File streaming error: ${event.error}`);
  }
}

async function* decodeChunks(
  events: AsyncGenerator<FileStreamEvent>,
  initialMetadata: FileMetadata
): AsyncGenerator<FileChunk, FileMetadata> {
  let metadata = initialMetadata;

  for await (const event of events) {
    switch (event.type) {
      case 'metadata':
        metadata = toFileMetadata(event);
        break;

      case 'chunk':
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
        return metadata;

      case 'error':
        throw new Error(`File streaming error: ${event.error}`);
    }
  }

  throw new Error('Stream ended unexpectedly');
}

function toFileMetadata(
  event: Extract<FileStreamEvent, { type: 'metadata' }>
): FileMetadata {
  return {
    mimeType: event.mimeType,
    size: event.size,
    isBinary: event.isBinary,
    encoding: event.encoding
  };
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
