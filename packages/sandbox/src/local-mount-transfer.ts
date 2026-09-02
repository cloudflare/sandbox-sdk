const MAX_UPLOAD_PARTS = 10_000;

interface LocalMountFileStream {
  content: ReadableStream<Uint8Array>;
  size: number;
}

interface UploadLocalMountFileOptions {
  bucket: R2Bucket;
  key: string;
  file: LocalMountFileStream;
  partBytes: number;
  signal: AbortSignal;
}

export async function uploadLocalMountFile({
  bucket,
  key,
  file,
  partBytes,
  signal
}: UploadLocalMountFileOptions): Promise<void> {
  const pending: Uint8Array[] = [];
  const parts: R2UploadedPart[] = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  let upload: R2MultipartUpload | null = null;

  const throwIfAborted = () => {
    if (signal.aborted) throw signal.reason;
  };
  const take = (size: number): Uint8Array => {
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
    for await (const chunk of readByteStream(file.content, signal)) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      totalBytes += chunk.byteLength;
      while (pendingBytes > partBytes) {
        throwIfAborted();
        if (parts.length >= MAX_UPLOAD_PARTS - 1) {
          throw new Error('File exceeds the R2 multipart upload limit');
        }
        upload ??= await bucket.createMultipartUpload(key);
        throwIfAborted();
        parts.push(await upload.uploadPart(parts.length + 1, take(partBytes)));
      }
    }
    throwIfAborted();
    if (totalBytes !== file.size) {
      throw new Error(
        `File stream size mismatch: expected ${file.size} bytes, received ${totalBytes}`
      );
    }
    if (upload) {
      parts.push(await upload.uploadPart(parts.length + 1, take(pendingBytes)));
      throwIfAborted();
      await upload.complete(parts);
    } else {
      await bucket.put(key, take(pendingBytes));
    }
  } catch (error) {
    if (upload) await upload.abort().catch(() => {});
    throw error;
  }
}

interface AbortableByteStream {
  stream: ReadableStream<Uint8Array>;
  cancel(reason: unknown): void;
}

export function abortableByteStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AbortableByteStream {
  const stream = source;
  const reader = stream.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancel = (reason: unknown) => {
    void reader
      .cancel(reason)
      .catch(() => {})
      .finally(release)
      .catch(() => {});
  };
  const stop = (reason: unknown, errorOutput: boolean) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    cancel(reason);
    if (errorOutput) {
      try {
        controller.error(reason);
      } catch {
        return;
      }
    }
  };
  const abort = () => stop(signal.reason, true);

  const output = new ReadableStream<Uint8Array>({
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
    cancel(reason) {
      stop(reason, false);
    }
  });
  return { stream: output, cancel: (reason) => stop(reason, true) };
}

export async function readLocalMountBytes(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of readByteStream(stream, signal)) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function* readByteStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  const abort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) {
        completed = true;
        return;
      }
      yield value;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!completed) {
      await reader
        .cancel(
          signal.aborted
            ? signal.reason
            : new Error('local mount upload stopped reading the file stream')
        )
        .catch(() => {});
    }
    reader.releaseLock();
  }
}
