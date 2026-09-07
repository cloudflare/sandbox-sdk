import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalMountSyncManager,
  UPLOAD_DEBOUNCE_MS
} from '../src/local-mount-sync';

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Helpers to build mock R2 objects
// ---------------------------------------------------------------------------

function makeR2Object(
  key: string,
  body: string,
  etag = `etag-${key}`,
  size = body.length
) {
  const bytes = encoder.encode(body);
  return {
    key,
    etag,
    // `size` can exceed the body length: R2 reports the object size, and the
    // sync manager uses it to pick the streaming transfer path.
    size,
    body: createByteStream(bytes),
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer)
  } as unknown as R2ObjectBody;
}

function makeR2Head(key: string, size: number, etag = `etag-${key}`) {
  return { key, etag, size } as unknown as R2Object;
}

function createByteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

async function drainStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
  }
  return byteLength;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Build the SSE stream shape that files.readFileStream() returns: a metadata
 * event, one event per chunk, then completion. Uint8Array chunks are sent as
 * base64 (binary file), strings verbatim (text file).
 */
function createFileReadStream(
  chunks: Array<string | Uint8Array>
): ReadableStream<Uint8Array> {
  const isBinary = chunks.some((chunk) => chunk instanceof Uint8Array);
  const bytes = chunks.map((chunk) =>
    typeof chunk === 'string' ? encoder.encode(chunk) : chunk
  );
  const frame = (event: Record<string, unknown>) =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        frame({
          type: 'metadata',
          mimeType: isBinary ? 'application/octet-stream' : 'text/plain',
          size: bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0),
          isBinary,
          encoding: isBinary ? 'base64' : 'utf-8'
        })
      );
      for (const chunk of chunks) {
        controller.enqueue(
          frame({
            type: 'chunk',
            data: typeof chunk === 'string' ? chunk : toBase64(chunk)
          })
        );
      }
      controller.enqueue(frame({ type: 'complete' }));
      controller.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface MultipartUploadRecord {
  key: string;
  parts: Array<{ partNumber: number; bytes: Uint8Array }>;
  completed: boolean;
  aborted: boolean;
}

function createMockR2Bucket(
  objects: Map<string, { body: string; etag: string; size?: number }>,
  options: { failUploadPart?: number } = {}
) {
  const multipartUploads: MultipartUploadRecord[] = [];
  const bucket = {
    list: vi.fn(async (opts?: R2ListOptions) => {
      const result: R2Object[] = [];
      for (const [key, val] of objects) {
        if (opts?.prefix && !key.startsWith(opts.prefix)) continue;
        result.push(makeR2Head(key, val.size ?? val.body.length, val.etag));
      }
      return {
        objects: result,
        truncated: false,
        cursor: undefined,
        delimitedPrefixes: []
      } as unknown as R2Objects;
    }),
    get: vi.fn(async (key: string) => {
      const val = objects.get(key);
      if (!val) return null;
      return makeR2Object(key, val.body, val.etag, val.size);
    }),
    put: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    head: vi.fn(async (key: string) => {
      const val = objects.get(key);
      if (!val) return null;
      return makeR2Head(key, val.size ?? val.body.length, val.etag);
    }),
    createMultipartUpload: vi.fn(async (key: string) => {
      const record: MultipartUploadRecord = {
        key,
        parts: [],
        completed: false,
        aborted: false
      };
      multipartUploads.push(record);
      return {
        key,
        uploadId: `upload-${multipartUploads.length}`,
        uploadPart: vi.fn(async (partNumber: number, value: Uint8Array) => {
          if (options.failUploadPart === partNumber) {
            throw new Error(`part ${partNumber} rejected`);
          }
          record.parts.push({ partNumber, bytes: value });
          return { partNumber, etag: `etag-part-${partNumber}` };
        }),
        complete: vi.fn(async () => {
          record.completed = true;
          return makeR2Head(key, 0);
        }),
        abort: vi.fn(async () => {
          record.aborted = true;
        })
      } as unknown as R2MultipartUpload;
    }),
    resumeMultipartUpload: vi.fn(),
    multipartUploads
  } as unknown as R2Bucket & {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    head: ReturnType<typeof vi.fn>;
    createMultipartUpload: ReturnType<typeof vi.fn>;
    multipartUploads: MultipartUploadRecord[];
  };
  return bucket;
}

function createMockFileClient(
  fileChunks: Array<string | Uint8Array> = ['file-content']
) {
  return {
    mkdir: vi.fn(async () => ({
      success: true,
      exitCode: 0,
      path: '',
      recursive: true,
      timestamp: new Date().toISOString()
    })),
    writeFile: vi.fn(async () => ({
      success: true,
      path: '',
      bytesWritten: 0,
      timestamp: new Date().toISOString()
    })),
    writeFileStream: vi.fn(
      async (path: string, content: ReadableStream<Uint8Array>) => ({
        success: true,
        path,
        bytesWritten: await drainStream(content),
        timestamp: new Date().toISOString()
      })
    ),
    readFile: vi.fn(async () => ({
      content: createByteStream(
        concatBytes(
          fileChunks.map((chunk) =>
            typeof chunk === 'string' ? encoder.encode(chunk) : chunk
          )
        )
      )
    })),
    readFileStream: vi.fn(async () => createFileReadStream(fileChunks)),
    deleteFile: vi.fn(async () => ({
      success: true,
      path: '',
      timestamp: new Date().toISOString()
    }))
  };
}

function createMockWatchClient() {
  // Returns a stream that never emits (watch loop runs in background)
  return {
    watch: vi.fn(
      async () =>
        new ReadableStream({
          start() {
            // Stream stays open — test will stop the manager to clean up
          }
        })
    )
  };
}

/**
 * Creates a watch client whose stream can be driven from the test.
 * Call `emit(event)` to push SSE-formatted events into the stream,
 * and `close()` to end it.
 */
function createControllableWatchClient() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });

  const emit = (event: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    controller!.enqueue(encoder.encode(frame));
  };

  const close = () => {
    controller!.close();
  };

  return {
    client: {
      watch: vi.fn(async () => stream)
    },
    emit,
    close
  };
}

function createMockSandboxClient(
  fileClient: ReturnType<typeof createMockFileClient>,
  watchClient: ReturnType<typeof createMockWatchClient>,
  transportMode: 'http' | 'websocket' | 'rpc' = 'http'
) {
  return {
    files: fileClient,
    watch: watchClient,
    getTransportMode: vi.fn(() => transportMode)
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Yield to the microtask queue so the watch loop processes emitted events
const flush = () => vi.advanceTimersByTimeAsync(0);

// Container -> R2 uploads are debounced; let the trailing timer fire
const settleUpload = async () => {
  await flush();
  await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
};

describe('LocalMountSyncManager', () => {
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createNoOpLogger();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initial full sync (R2 → Container)', () => {
    it('should sync all R2 objects to the container on start', async () => {
      const r2Objects = new Map([
        ['file1.txt', { body: 'hello', etag: 'etag1' }],
        ['dir/file2.txt', { body: 'world', etag: 'etag2' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // Should create mount directory
      expect(fileClient.mkdir).toHaveBeenCalledWith(
        '/mnt/data',
        'test-session',
        { recursive: true }
      );

      // Should list all R2 objects
      expect(bucket.list).toHaveBeenCalled();

      // Should fetch each object
      expect(bucket.get).toHaveBeenCalledWith('file1.txt');
      expect(bucket.get).toHaveBeenCalledWith('dir/file2.txt');

      // Should write files to container (base64 encoded)
      expect(fileClient.writeFile).toHaveBeenCalledTimes(2);
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/file1.txt',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/dir/file2.txt',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );

      // Should create parent directories for nested files
      expect(fileClient.mkdir).toHaveBeenCalledWith(
        '/mnt/data/dir',
        'test-session',
        { recursive: true }
      );

      await manager.stop();
    });

    it('should transfer objects one at a time, on start and on poll', async () => {
      const r2Objects = new Map([
        ['a.txt', { body: 'a', etag: 'etag-a' }],
        ['b.txt', { body: 'b', etag: 'etag-b' }],
        ['c.txt', { body: 'c', etag: 'etag-c' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      // A transfer that overlaps another shares the RPC session with it, so
      // record how many are ever in flight at once.
      let inFlight = 0;
      let maxInFlight = 0;
      fileClient.writeFile.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return {
          success: true,
          path: '',
          bytesWritten: 0,
          timestamp: new Date().toISOString()
        };
      });

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();

      expect(fileClient.writeFile).toHaveBeenCalledTimes(3);
      expect(maxInFlight).toBe(1);

      r2Objects.set('d.txt', { body: 'd', etag: 'etag-d' });
      r2Objects.set('e.txt', { body: 'e', etag: 'etag-e' });
      r2Objects.set('f.txt', { body: 'f', etag: 'etag-f' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(fileClient.writeFile).toHaveBeenCalledTimes(6);
      expect(maxInFlight).toBe(1);

      await manager.stop();
    });

    it('should not start container watch when readOnly is true', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // Watch should NOT be called in readOnly mode
      expect(watchClient.watch).not.toHaveBeenCalled();

      await manager.stop();
    });

    it('should start container watch when readOnly is false', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // Watch should be called for bidirectional sync
      expect(watchClient.watch).toHaveBeenCalledWith({
        path: '/mnt/data',
        recursive: true,
        sessionId: 'test-session'
      });

      await manager.stop();
    });
  });

  describe('large object transfer (R2 → Container)', () => {
    // Above the streaming threshold, and far past what base64 in Worker
    // memory can represent as a single V8 string.
    const LARGE_OBJECT_SIZE = 1024 * 1024 * 1024;

    function createManager(client: unknown, bucket: R2Bucket) {
      return new LocalMountSyncManager({
        bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client: client as never,
        sessionId: 'test-session',
        logger
      });
    }
    it('should keep base64 writes for large objects on non-rpc transports', async () => {
      const r2Objects = new Map([
        [
          'backup.sqsh',
          { body: 'payload', etag: 'etag1', size: LARGE_OBJECT_SIZE }
        ]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient, 'http');

      const manager = createManager(client, bucket as unknown as R2Bucket);
      await manager.start();

      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/backup.sqsh',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );
      expect(fileClient.writeFileStream).not.toHaveBeenCalled();

      await manager.stop();
    });

    it('should stream an object too large for one base64 frame', async () => {
      // The archive size that closed the control socket in practice: 13.8 MB
      // of content is ~18.4 MB of base64, over the 16 MiB frame cap.
      const r2Objects = new Map([
        [
          'checkpoint.sqsh',
          { body: 'payload', etag: 'etag1', size: 13_800_000 }
        ]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient, 'rpc');

      const manager = createManager(client, bucket as unknown as R2Bucket);
      await manager.start();

      expect(fileClient.writeFileStream).toHaveBeenCalled();
      expect(fileClient.writeFile).not.toHaveBeenCalled();

      await manager.stop();
    });
  });

  describe('R2 poll diff detection', () => {
    it('should detect new objects on poll', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();

      // Clear initial sync calls
      fileClient.writeFile.mockClear();
      bucket.get.mockClear();

      // Add a new object to R2
      r2Objects.set('new-file.txt', { body: 'new content', etag: 'new-etag' });

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(1000);

      // Should detect and sync the new file
      expect(bucket.get).toHaveBeenCalledWith('new-file.txt');
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/new-file.txt',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );

      await manager.stop();
    });

    it('should detect modified objects (changed etag) on poll', async () => {
      const r2Objects = new Map([
        ['file.txt', { body: 'original', etag: 'etag-v1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();

      // Clear initial sync calls
      fileClient.writeFile.mockClear();
      bucket.get.mockClear();

      // Modify the etag (simulate R2 update)
      r2Objects.set('file.txt', { body: 'updated', etag: 'etag-v2' });

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(1000);

      // Should detect modification and re-sync
      expect(bucket.get).toHaveBeenCalledWith('file.txt');
      expect(fileClient.writeFile).toHaveBeenCalledTimes(1);

      await manager.stop();
    });

    it('should detect deleted objects on poll', async () => {
      const r2Objects = new Map([
        ['file.txt', { body: 'content', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();

      // Clear initial sync calls
      fileClient.deleteFile.mockClear();

      // Remove from R2
      r2Objects.delete('file.txt');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(1000);

      // Should detect deletion
      expect(fileClient.deleteFile).toHaveBeenCalledWith(
        '/mnt/data/file.txt',
        'test-session'
      );

      await manager.stop();
    });

    it('should not fetch unchanged objects', async () => {
      const r2Objects = new Map([
        ['file.txt', { body: 'content', etag: 'same-etag' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();

      // Clear initial sync
      bucket.get.mockClear();
      fileClient.writeFile.mockClear();

      // Advance timer — object unchanged
      await vi.advanceTimersByTimeAsync(1000);

      // Should NOT fetch the unchanged object
      expect(bucket.get).not.toHaveBeenCalled();
      expect(fileClient.writeFile).not.toHaveBeenCalled();

      await manager.stop();
    });
  });

  describe('prefix filtering', () => {
    it('should strip prefix from container paths', async () => {
      const r2Objects = new Map([
        ['data/file.txt', { body: 'content', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/data/',
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // Leading slash stripped for R2 key semantics
      expect(bucket.list).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: 'data/' })
      );

      // Container path should have prefix stripped
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/file.txt',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );

      await manager.stop();
    });

    it('should normalize leading-slash prefix for R2 list and path mapping', async () => {
      const r2Objects = new Map([
        ['some/prefix/file.txt', { body: 'content', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/some/prefix/',
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // Leading slash must be stripped before passing to R2
      expect(bucket.list).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: 'some/prefix/' })
      );

      // Container path should have prefix stripped
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/file.txt',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );

      await manager.stop();
    });

    it('should normalize leading-slash prefix for Container→R2 uploads', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/some/prefix/',
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      emit({
        type: 'event',
        eventType: 'create',
        path: '/mnt/data/foo.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      // R2 key must NOT have a leading slash
      expect(bucket.put).toHaveBeenCalledWith(
        'some/prefix/foo.txt',
        expect.any(Uint8Array)
      );

      close();
      await manager.stop();
    });

    it('should treat a bare slash prefix as no prefix', async () => {
      const r2Objects = new Map([
        ['file.txt', { body: 'content', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/',
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // Bare '/' stripped to empty string → treated as undefined (no prefix filter)
      expect(bucket.list).toHaveBeenCalledWith({});

      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/file.txt',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );

      await manager.stop();
    });

    it('should reject prefix without leading slash (matches production)', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      expect(
        () =>
          new LocalMountSyncManager({
            bucket: bucket as unknown as R2Bucket,
            mountPath: '/mnt/data',
            prefix: 'data/',
            readOnly: true,
            client,
            sessionId: 'test-session',
            logger
          })
      ).toThrow(/Prefix must start with/);
    });

    it('should handle prefix without trailing slash', async () => {
      const r2Objects = new Map([
        ['uploads/photo.jpg', { body: 'img', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/uploads',
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // File must land inside mount dir, not at absolute '/photo.jpg'
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/photo.jpg',
        expect.any(String),
        'test-session',
        { encoding: 'base64' }
      );

      await manager.stop();
    });
  });

  describe('Container to R2 (watch direction)', () => {
    it('should upload file to R2 on create event', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      // Emit a create event for a new file
      emit({
        type: 'event',
        eventType: 'create',
        path: '/mnt/data/hello.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      // Should read the file from the container as a stream
      expect(fileClient.readFileStream).toHaveBeenCalledWith(
        '/mnt/data/hello.txt',
        'test-session'
      );

      // Should upload to R2
      expect(bucket.put).toHaveBeenCalledWith(
        'hello.txt',
        expect.any(Uint8Array)
      );

      // Should update snapshot via head
      expect(bucket.head).toHaveBeenCalledWith('hello.txt');

      close();
      await manager.stop();
    });

    it('should upload file to R2 on modify event', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/existing.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      expect(fileClient.readFileStream).toHaveBeenCalledWith(
        '/mnt/data/existing.txt',
        'test-session'
      );
      expect(bucket.put).toHaveBeenCalledWith(
        'existing.txt',
        expect.any(Uint8Array)
      );

      close();
      await manager.stop();
    });

    it('should delete object from R2 on delete event', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      emit({
        type: 'event',
        eventType: 'delete',
        path: '/mnt/data/removed.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      // Should delete from R2, NOT read/upload
      expect(bucket.delete).toHaveBeenCalledWith('removed.txt');
      expect(fileClient.readFileStream).not.toHaveBeenCalled();
      expect(bucket.put).not.toHaveBeenCalled();

      close();
      await manager.stop();
    });

    it('should handle move_to as upload and move_from as delete', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      // move_from should delete old key
      emit({
        type: 'event',
        eventType: 'move_from',
        path: '/mnt/data/old-name.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await flush();
      expect(bucket.delete).toHaveBeenCalledWith('old-name.txt');

      // move_to should upload new key
      emit({
        type: 'event',
        eventType: 'move_to',
        path: '/mnt/data/new-name.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();
      expect(bucket.put).toHaveBeenCalledWith(
        'new-name.txt',
        expect.any(Uint8Array)
      );

      close();
      await manager.stop();
    });

    it('should skip directory events', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      emit({
        type: 'event',
        eventType: 'create',
        path: '/mnt/data/subdir',
        isDirectory: true,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      expect(fileClient.readFileStream).not.toHaveBeenCalled();
      expect(bucket.put).not.toHaveBeenCalled();

      close();
      await manager.stop();
    });

    it('should skip events outside mount path', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      emit({
        type: 'event',
        eventType: 'create',
        path: '/other/path/file.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      expect(fileClient.readFileStream).not.toHaveBeenCalled();
      expect(bucket.put).not.toHaveBeenCalled();

      close();
      await manager.stop();
    });

    it('should prepend prefix when uploading to R2', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/uploads/',
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });

      await manager.start();

      emit({
        type: 'event',
        eventType: 'create',
        path: '/mnt/data/photo.jpg',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      // R2 key should include prefix (leading slash stripped)
      expect(bucket.put).toHaveBeenCalledWith(
        'uploads/photo.jpg',
        expect.any(Uint8Array)
      );

      close();
      await manager.stop();
    });
  });

  describe('Container → R2 upload parts', () => {
    // Small enough to exercise multipart without building a 16 MiB fixture
    const PART_BYTES = 16;

    async function uploadFileViaWatch(
      fileChunks: Array<string | Uint8Array>,
      options: {
        failUploadPart?: number;
        stream?: ReadableStream<Uint8Array>;
        transport?: 'http' | 'rpc';
        uploadPartBytes?: number;
      } = {}
    ) {
      const bucket = createMockR2Bucket(new Map(), options);
      const fileClient = createMockFileClient(fileChunks);
      if (options.stream) {
        fileClient.readFile.mockResolvedValue({ content: options.stream });
      }
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockSandboxClient(
        fileClient,
        watchClient,
        options.transport ?? 'rpc'
      );

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000,
        uploadPartBytes: options.uploadPartBytes ?? PART_BYTES
      });

      await manager.start();

      emit({
        type: 'event',
        eventType: 'create',
        path: '/mnt/data/archive.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });

      await settleUpload();

      close();
      await manager.stop();

      return bucket;
    }

    it('should upload a file larger than one part as fixed-size parts', async () => {
      // 40 bytes arriving in 7-byte chunks: parts must be sliced to the part
      // size (16 + 16 + 8), not left chunk-aligned — R2 rejects a multipart
      // upload whose non-final parts differ in size.
      const source = Uint8Array.from({ length: 40 }, (_, i) => i);
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < source.byteLength; offset += 7) {
        chunks.push(source.subarray(offset, offset + 7));
      }

      const bucket = await uploadFileViaWatch(chunks);

      expect(bucket.put).not.toHaveBeenCalled();
      expect(bucket.multipartUploads).toHaveLength(1);

      const [upload] = bucket.multipartUploads;
      expect(upload.key).toBe('archive.bin');
      expect(upload.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
      expect(upload.parts.map((part) => part.bytes.byteLength)).toEqual([
        PART_BYTES,
        PART_BYTES,
        8
      ]);
      expect(concatBytes(upload.parts.map((part) => part.bytes))).toEqual(
        source
      );
      expect(upload.completed).toBe(true);
      expect(upload.aborted).toBe(false);
    });

    it('streams compatibility uploads above the encoded read limit', async () => {
      const mebibyte = new Uint8Array(1024 * 1024);
      const bucket = await uploadFileViaWatch(Array(33).fill(mebibyte), {
        transport: 'http',
        uploadPartBytes: 16 * 1024 * 1024
      });

      expect(bucket.multipartUploads).toHaveLength(1);
      expect(bucket.put).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload and source stream on failure', async () => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(40));
        },
        cancel
      });
      const bucket = await uploadFileViaWatch([], {
        failUploadPart: 2,
        stream
      });

      const [upload] = bucket.multipartUploads;
      expect(upload.aborted).toBe(true);
      expect(upload.completed).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  describe('upload debounce', () => {
    function createManagerForWatch(
      bucket: ReturnType<typeof createMockR2Bucket>,
      fileClient: ReturnType<typeof createMockFileClient>,
      watchClient: ReturnType<typeof createControllableWatchClient>['client']
    ) {
      return new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        client: createMockSandboxClient(fileClient, watchClient),
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 60_000
      });
    }

    it('should collapse a burst of writes into one upload', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();

      const manager = createManagerForWatch(bucket, fileClient, watchClient);
      await manager.start();

      const write = (eventType: string) => {
        emit({
          type: 'event',
          eventType,
          path: '/mnt/data/archive.tar',
          isDirectory: false,
          timestamp: new Date().toISOString()
        });
        return flush();
      };

      // A large file written into the mount emits create + a stream of modify
      // events; each one has to push the upload out again.
      await write('create');
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS - 500);
        await write('modify');
      }

      expect(fileClient.readFileStream).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);

      expect(fileClient.readFileStream).toHaveBeenCalledTimes(1);
      expect(bucket.put).toHaveBeenCalledTimes(1);
      expect(bucket.put).toHaveBeenCalledWith(
        'archive.tar',
        expect.any(Uint8Array)
      );

      close();
      await manager.stop();
    });

    it('should cancel a pending upload when the file is deleted', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();

      const manager = createManagerForWatch(bucket, fileClient, watchClient);
      await manager.start();

      emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/scratch.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await flush();

      emit({
        type: 'event',
        eventType: 'delete',
        path: '/mnt/data/scratch.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await flush();

      expect(bucket.delete).toHaveBeenCalledWith('scratch.bin');

      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);

      // The queued upload must not resurrect the deleted object
      expect(fileClient.readFileStream).not.toHaveBeenCalled();
      expect(bucket.put).not.toHaveBeenCalled();

      close();
      await manager.stop();
    });
  });

  describe('stop', () => {
    it('should stop polling and clean up', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockSandboxClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();

      // Reset list call count
      bucket.list.mockClear();

      await manager.stop();

      // Advance timers — should NOT trigger another poll
      await vi.advanceTimersByTimeAsync(5000);

      expect(bucket.list).not.toHaveBeenCalled();
    });
  });
});
