import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerControlClient } from '../src/container-control';
import {
  LocalMountSyncManager,
  UPLOAD_DEBOUNCE_MS
} from '../src/local-mount-sync';
import { mountLocalSyncBucket } from '../src/storage-mount/operations/local-sync-mount';
import { MountRegistry } from '../src/storage-mount/registry';

// ---------------------------------------------------------------------------
// Helpers to build mock R2 objects
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function createByteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

function makeR2Object(key: string, body: string, etag = `etag-${key}`) {
  const bytes = new TextEncoder().encode(body);
  const buffer = bytes.buffer as ArrayBuffer;
  return {
    key,
    etag,
    size: bytes.byteLength,
    body: createByteStream(bytes),
    arrayBuffer: () => Promise.resolve(buffer)
  } as unknown as R2ObjectBody;
}

function makeR2Head(key: string, size: number, etag = `etag-${key}`) {
  return { key, etag, size } as unknown as R2Object;
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
  objects: Map<string, { body: string; etag: string }>,
  options: { failUploadPart?: number } = {}
) {
  const multipartUploads: MultipartUploadRecord[] = [];
  const bucket = {
    list: vi.fn(async (opts?: R2ListOptions) => {
      const result: R2Object[] = [];
      for (const [key, val] of objects) {
        if (opts?.prefix && !key.startsWith(opts.prefix)) continue;
        result.push(makeR2Head(key, val.body.length, val.etag));
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
      return makeR2Object(key, val.body, val.etag);
    }),
    put: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    head: vi.fn(async (key: string) => {
      const val = objects.get(key);
      if (!val) return null;
      return makeR2Head(key, val.body.length, val.etag);
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
  chunks: Array<string | Uint8Array> = [encoder.encode('file-content')],
  onStreamCancel?: (reason: unknown) => void
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
    writeFileStream: vi.fn(async () => ({
      success: true,
      path: '',
      bytesWritten: 0,
      timestamp: new Date().toISOString()
    })),
    readFile: vi.fn(async (_path: string, opts?: { encoding?: string }) => {
      const byteChunks = chunks.map((chunk) =>
        typeof chunk === 'string' ? encoder.encode(chunk) : chunk
      );
      const size = byteChunks.reduce(
        (total, chunk) => total + chunk.byteLength,
        0
      );
      if (opts?.encoding === 'none') {
        return {
          success: true,
          content: new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of byteChunks) controller.enqueue(chunk);
              if (!onStreamCancel) controller.close();
            },
            cancel: onStreamCancel
          }),
          path: _path,
          size,
          mimeType: 'application/octet-stream',
          timestamp: new Date().toISOString()
        };
      }
      return {
        success: true,
        content:
          opts?.encoding === 'base64' ? btoa('file-content') : 'file-content',
        path: _path,
        encoding: opts?.encoding || 'utf-8',
        size: 12,
        timestamp: new Date().toISOString()
      };
    }),
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
    watch: vi.fn(async () => ({
      stream: vi.fn(
        async () =>
          new ReadableStream({
            start() {
              // Stream stays open — test will stop the manager to clean up
            }
          })
      ),
      cancel: vi.fn(async () => undefined),
      [Symbol.dispose]: vi.fn()
    }))
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
  const cancel = vi.fn(async () => undefined);
  const dispose = vi.fn();

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
  const fail = (error: Error) => {
    controller!.error(error);
  };

  return {
    client: {
      watch: vi.fn(async () => ({
        stream: vi.fn(async () => stream),
        cancel,
        [Symbol.dispose]: dispose
      }))
    },
    emit,
    close,
    fail,
    cancel,
    dispose
  };
}

function createMockControlClient(
  fileClient: ReturnType<typeof createMockFileClient>,
  watchClient: ReturnType<typeof createMockWatchClient>
) {
  return {
    files: fileClient,
    watch: watchClient
  } as unknown as ContainerControlClient;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  describe('mount lifecycle', () => {
    it('releases retained runtime authority when capture fails', async () => {
      const release = vi.fn();
      const bucket = createMockR2Bucket(new Map());
      const client = createMockControlClient(
        createMockFileClient(),
        createMockWatchClient()
      );
      const context = {
        registry: new MountRegistry(),
        logger,
        runRuntimeCall: async (
          _operation: string,
          call: (control: ContainerControlClient) => Promise<unknown>
        ) => await call(client),
        getOutboundHost: () => ({}),
        s3fsHost: null,
        getEnv: () => ({ BUCKET: bucket }),
        lifecycle: {
          capture: vi.fn().mockRejectedValue(new Error('capture failed')),
          assertCurrent: vi.fn()
        },
        runtime: {},
        retainRuntime: () => ({ release })
      } as unknown as Parameters<typeof mountLocalSyncBucket>[0];

      await expect(
        mountLocalSyncBucket(context, 'BUCKET', '/mnt/data', {
          localBucket: true,
          readOnly: true
        })
      ).rejects.toThrow('capture failed');

      expect(release).toHaveBeenCalledTimes(1);
      expect(context.registry.has('/mnt/data')).toBe(false);
    });
  });

  describe('runtime callback scoping', () => {
    it('releases retained runtime authority exactly once', async () => {
      const release = vi.fn();
      const manager = new LocalMountSyncManager({
        bucket: createMockR2Bucket(new Map()) as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) =>
          await call(
            createMockControlClient(
              createMockFileClient(),
              createMockWatchClient()
            )
          ),
        runtimeHold: { release },
        logger
      });

      manager.interrupt();
      await manager.stop();

      expect(release).toHaveBeenCalledTimes(1);
    });

    it('delegates sequential file RPCs through the provided scope', async () => {
      const r2Objects = new Map([
        ['file1.txt', { body: 'hello', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const watchClient = createMockWatchClient();
      const controls: ReturnType<typeof createMockControlClient>[] = [];

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => {
          const control = createMockControlClient(
            createMockFileClient(),
            watchClient
          );
          controls.push(control);
          return await call(control);
        },
        runtimeHold: { release: () => {} },
        logger
      });

      await manager.start();

      expect(controls.length).toBeGreaterThanOrEqual(2);
      expect(new Set(controls).size).toBe(controls.length);
    });

    it('stop remains pending until the active watch callback settles', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const watchRelease = deferred();
      let watchEntered = false;
      let stopped = false;

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (operation, call) => {
          if (operation === 'mount.local.watch') {
            watchEntered = true;
          }
          const result = await call(client);
          if (operation === 'mount.local.watch') {
            await watchRelease.promise;
          }
          return result;
        },
        runtimeHold: { release: () => {} },
        logger
      });

      await manager.start();
      await vi.waitFor(() => expect(watchEntered).toBe(true));

      const stopPromise = manager.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();

      expect(stopped).toBe(false);
      watchRelease.resolve();
      await stopPromise;
      expect(stopped).toBe(true);
    });
    it('does not reconnect after a stopped watch callback rejects', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (operation, call) => {
          if (operation === 'mount.local.watch') {
            throw new Error('runtime replaced');
          }
          return await call(client);
        },
        runtimeHold: { release: () => {} },
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();
      await manager.stop();
      await vi.advanceTimersByTimeAsync(5000);

      expect(watch.client.watch).not.toHaveBeenCalled();
    });

    it('stop joins already-admitted poll work and prevents later poll RPCs', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);
      const writeRelease = deferred();
      const operations: string[] = [];
      let stopped = false;

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (operation, call) => {
          operations.push(operation);
          if (operation === 'mount.local.writeFile') {
            await writeRelease.promise;
          }
          return await call(client);
        },
        runtimeHold: { release: () => {} },
        logger,
        pollIntervalMs: 1000
      });

      await manager.start();
      operations.length = 0;
      r2Objects.set('new-file.txt', { body: 'new', etag: 'etag-new' });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() =>
        expect(operations).toContain('mount.local.writeFile')
      );

      const stopPromise = manager.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      writeRelease.resolve();
      await stopPromise;

      operations.length = 0;
      r2Objects.set('later.txt', { body: 'later', etag: 'etag-later' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(operations).toEqual([]);
    });

    it('watch events read files through a fresh control outside the watch control', async () => {
      const bucket = createMockR2Bucket(new Map());
      const watch = createControllableWatchClient();
      const watchControl = createMockControlClient(
        createMockFileClient(),
        watch.client
      );
      const readControl = createMockControlClient(
        createMockFileClient(),
        createMockWatchClient()
      );
      const controlsByOperation = new Map<string, unknown[]>();

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (operation, call) => {
          const control =
            operation === 'mount.local.readFile' ? readControl : watchControl;
          controlsByOperation.set(operation, [
            ...(controlsByOperation.get(operation) ?? []),
            control
          ]);
          return await call(control);
        },
        runtimeHold: { release: () => {} },
        logger
      });

      await manager.start();
      await vi.waitFor(() => expect(watch.client.watch).toHaveBeenCalled());
      watch.emit({
        type: 'event',
        path: '/mnt/data/file.txt',
        eventType: 'modify',
        isDirectory: false
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(readControl.files.readFile).toHaveBeenCalledWith(
        '/mnt/data/file.txt',
        { encoding: 'none' }
      );

      expect(controlsByOperation.get('mount.local.watch')).toEqual([
        watchControl
      ]);
      expect(controlsByOperation.get('mount.local.readFile')).toEqual([
        readControl
      ]);
      expect(readControl).not.toBe(watchControl);
      watch.close();
      await manager.stop();
    });

    it('keeps the local watch runtime callback pending until the stream closes', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const settled: string[] = [];

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (operation, call) => {
          const result = await call(client);
          settled.push(operation);
          return result;
        },
        runtimeHold: { release: () => {} },
        logger
      });

      await manager.start();
      await vi.waitFor(() => expect(watch.client.watch).toHaveBeenCalled());
      await Promise.resolve();

      expect(settled).not.toContain('mount.local.watch');

      watch.close();
      await vi.waitFor(() => expect(settled).toContain('mount.local.watch'));
      await manager.stop();
    });
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger
      });

      await manager.start();

      // Should create mount directory
      expect(fileClient.mkdir).toHaveBeenCalledWith('/mnt/data', {
        recursive: true
      });

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
        { encoding: 'base64' }
      );
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/dir/file2.txt',
        expect.any(String),
        { encoding: 'base64' }
      );

      // Should create parent directories for nested files
      expect(fileClient.mkdir).toHaveBeenCalledWith('/mnt/data/dir', {
        recursive: true
      });

      await manager.stop();
    });

    it('transfers objects sequentially on start and poll', async () => {
      const r2Objects = new Map([
        ['a.txt', { body: 'a', etag: 'etag-a' }],
        ['b.txt', { body: 'b', etag: 'etag-b' }],
        ['c.txt', { body: 'c', etag: 'etag-c' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const client = createMockControlClient(
        fileClient,
        createMockWatchClient()
      );
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
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 1000
      });

      await manager.start();
      expect(maxInFlight).toBe(1);

      r2Objects.set('d.txt', { body: 'd', etag: 'etag-d' });
      r2Objects.set('e.txt', { body: 'e', etag: 'etag-e' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(fileClient.writeFile).toHaveBeenCalledTimes(5);
      expect(maxInFlight).toBe(1);
      await manager.stop();
    });

    it('should not start container watch when readOnly is true', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger
      });

      await manager.start();

      // Watch should be called for bidirectional sync
      expect(watchClient.watch).toHaveBeenCalledWith({
        path: '/mnt/data',
        recursive: true
      });

      await manager.stop();
    });
  });

  describe('large object transfer (R2 → Container)', () => {
    it('streams an object too large for one base64 control frame', async () => {
      const bucket = createMockR2Bucket(
        new Map([['checkpoint.sqsh', { body: 'payload', etag: 'etag1' }]])
      );
      const body = createByteStream(encoder.encode('payload'));
      bucket.get.mockResolvedValueOnce({
        ...makeR2Object('checkpoint.sqsh', 'payload', 'etag1'),
        size: 13_800_000,
        body
      } as unknown as R2ObjectBody);
      const fileClient = createMockFileClient();
      const client = createMockControlClient(
        fileClient,
        createMockWatchClient()
      );
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger
      });

      await manager.start();

      expect(fileClient.writeFileStream).toHaveBeenCalledWith(
        '/mnt/data/checkpoint.sqsh',
        expect.any(ReadableStream)
      );
      expect(fileClient.writeFile).not.toHaveBeenCalled();
      await manager.stop();
    });

    it('cancels the R2 body when a streamed write rejects', async () => {
      const bucket = createMockR2Bucket(
        new Map([['checkpoint.sqsh', { body: 'payload', etag: 'etag1' }]])
      );
      const sourceCancel = vi.fn();
      bucket.get.mockResolvedValueOnce({
        ...makeR2Object('checkpoint.sqsh', 'payload', 'etag1'),
        size: 13_800_000,
        body: new ReadableStream<Uint8Array>({
          start() {},
          cancel: sourceCancel
        })
      } as unknown as R2ObjectBody);
      const fileClient = createMockFileClient();
      fileClient.writeFileStream.mockRejectedValue(
        new Error('stream write rejected')
      );
      const client = createMockControlClient(
        fileClient,
        createMockWatchClient()
      );
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger
      });

      await expect(manager.start()).rejects.toThrow('stream write rejected');
      expect(sourceCancel).toHaveBeenCalledTimes(1);
      await manager.stop();
    });
  });

  describe('R2 poll diff detection', () => {
    it('should detect new objects on poll', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

    it('keeps echo suppression through overlapping updates', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 1000,
        echoSuppressTtlMs: 2000
      });
      await manager.start();

      r2Objects.set('updated.txt', { body: 'first', etag: 'etag-first' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fileClient.writeFile).toHaveBeenCalledTimes(1);

      const secondWrite = deferred();
      fileClient.writeFile.mockImplementationOnce(async () => {
        await secondWrite.promise;
        return {
          success: true,
          path: '/mnt/data/updated.txt',
          bytesWritten: 6,
          timestamp: new Date().toISOString()
        };
      });
      r2Objects.set('updated.txt', { body: 'second', etag: 'etag-second' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fileClient.writeFile).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      watch.emit({
        type: 'event',
        eventType: 'move_to',
        path: '/mnt/data/updated.txt',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fileClient.readFile).not.toHaveBeenCalled();
      expect(bucket.put).not.toHaveBeenCalled();

      secondWrite.resolve();
      await vi.advanceTimersByTimeAsync(0);
      watch.close();
      await manager.stop();
    });

    it('retries R2 deletions after a container delete failure', async () => {
      const r2Objects = new Map([
        ['file.txt', { body: 'content', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 1000
      });

      await manager.start();

      fileClient.deleteFile.mockClear();
      fileClient.deleteFile.mockRejectedValueOnce(new Error('delete failed'));
      r2Objects.delete('file.txt');

      await vi.advanceTimersByTimeAsync(1000);
      expect(fileClient.deleteFile).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fileClient.deleteFile).toHaveBeenCalledTimes(2);
      expect(fileClient.deleteFile).toHaveBeenLastCalledWith(
        '/mnt/data/file.txt'
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

  it('keeps and retries a modified object after transfer failure', async () => {
    const r2Objects = new Map([
      ['retry.txt', { body: 'original', etag: 'etag-1' }]
    ]);
    const bucket = createMockR2Bucket(r2Objects);
    const fileClient = createMockFileClient();
    const client = createMockControlClient(fileClient, createMockWatchClient());
    const manager = new LocalMountSyncManager({
      bucket: bucket as unknown as R2Bucket,
      mountPath: '/mnt/data',
      prefix: undefined,
      readOnly: true,
      runRuntimeCall: async (_operation, call) => call(client),
      logger,
      runtimeHold: { release: () => {} },
      pollIntervalMs: 1000
    });
    await manager.start();
    fileClient.writeFile.mockClear();
    fileClient.deleteFile.mockClear();
    fileClient.writeFile
      .mockRejectedValueOnce(new Error('temporary write failure'))
      .mockResolvedValue({
        success: true,
        path: '/mnt/data/retry.txt',
        bytesWritten: 7,
        timestamp: new Date().toISOString()
      });
    r2Objects.set('retry.txt', { body: 'updated', etag: 'etag-2' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(fileClient.deleteFile).not.toHaveBeenCalled();
    expect(fileClient.writeFile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fileClient.writeFile).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  describe('prefix filtering', () => {
    it('should strip prefix from container paths', async () => {
      const r2Objects = new Map([
        ['data/file.txt', { body: 'content', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/data/',
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/some/prefix/',
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/some/prefix/',
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);

      // R2 key must NOT have a leading slash
      expect(bucket.put).toHaveBeenCalledWith(
        'some/prefix/foo.txt',
        expect.any(Uint8Array)
      );

      close();
      await manager.stop();
    });

    it('releases its watch subscription exactly once after consuming data', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        cancel,
        dispose
      } = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watchClient);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(1);

      await manager.stop();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('should treat a bare slash prefix as no prefix', async () => {
      const r2Objects = new Map([
        ['file.txt', { body: 'content', etag: 'etag1' }]
      ]);
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/',
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger
      });

      await manager.start();

      // Bare '/' stripped to empty string → treated as undefined (no prefix filter)
      expect(bucket.list).toHaveBeenCalledWith({});

      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/file.txt',
        expect.any(String),
        { encoding: 'base64' }
      );

      await manager.stop();
    });

    it('should reject prefix without leading slash (matches production)', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      expect(
        () =>
          new LocalMountSyncManager({
            bucket: bucket as unknown as R2Bucket,
            mountPath: '/mnt/data',
            prefix: 'data/',
            readOnly: true,
            runRuntimeCall: async (_operation, call) => call(client),
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/uploads',
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger
      });

      await manager.start();

      expect(bucket.list).toHaveBeenCalledWith({ prefix: 'uploads/' });
      // File must land inside mount dir, not at absolute '/photo.jpg'
      expect(fileClient.writeFile).toHaveBeenCalledWith(
        '/mnt/data/photo.jpg',
        expect.any(String),
        { encoding: 'base64' }
      );

      await manager.stop();
    });
  });

  describe('Container to R2 (watch direction)', () => {
    // Yield to the microtask queue so the watch loop processes emitted events
    const flush = () => vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);

    it('should upload file to R2 on create event', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const fileClient = createMockFileClient();
      const {
        client: watchClient,
        emit,
        close
      } = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await flush();

      expect(fileClient.readFile).toHaveBeenCalledWith('/mnt/data/hello.txt', {
        encoding: 'none'
      });

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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await flush();

      expect(fileClient.readFile).toHaveBeenCalledWith(
        '/mnt/data/existing.txt',
        { encoding: 'none' }
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await flush();

      // Should delete from R2, NOT read/upload
      expect(bucket.delete).toHaveBeenCalledWith('removed.txt');
      expect(fileClient.readFile).not.toHaveBeenCalled();
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await flush();
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await flush();

      expect(fileClient.readFile).not.toHaveBeenCalled();
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await flush();

      expect(fileClient.readFile).not.toHaveBeenCalled();
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
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: '/uploads/',
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

      await flush();

      // R2 key should include prefix (leading slash stripped)
      expect(bucket.put).toHaveBeenCalledWith(
        'uploads/photo.jpg',
        expect.any(Uint8Array)
      );

      close();
      await manager.stop();
    });
  });

  it('syncs persistent files that resemble atomic write paths', async () => {
    const bucket = createMockR2Bucket(new Map());
    const fileClient = createMockFileClient();
    const watch = createControllableWatchClient();
    const client = createMockControlClient(fileClient, watch.client);
    const manager = new LocalMountSyncManager({
      bucket: bucket as unknown as R2Bucket,
      mountPath: '/mnt/data',
      prefix: undefined,
      readOnly: false,
      runRuntimeCall: async (_operation, call) => call(client),
      logger,
      runtimeHold: { release: () => {} },
      pollIntervalMs: 60_000
    });
    await manager.start();

    const name = 'artifact.tmp.123e4567-e89b-42d3-a456-426614174000';
    watch.emit({
      type: 'event',
      eventType: 'modify',
      path: `/mnt/data/${name}`,
      isDirectory: false,
      timestamp: new Date().toISOString()
    });
    await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);

    expect(bucket.put).toHaveBeenCalledWith(name, expect.any(Uint8Array));
    watch.close();
    await manager.stop();
  });

  describe('Container → R2 streaming uploads', () => {
    const partBytes = 16;

    async function uploadFileViaWatch(
      chunks: Array<string | Uint8Array>,
      options: {
        failUploadPart?: number;
        onStreamCancel?: (reason: unknown) => void;
      } = {}
    ) {
      const bucket = createMockR2Bucket(new Map(), {
        failUploadPart: options.failUploadPart
      });
      const fileClient = createMockFileClient(chunks, options.onStreamCancel);
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000,
        uploadPartBytes: partBytes
      });

      await manager.start();
      watch.emit({
        type: 'event',
        eventType: 'create',
        path: '/mnt/data/archive.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      watch.close();
      if (options.failUploadPart === undefined) {
        await manager.stop();
      } else {
        manager.interrupt();
        await vi.advanceTimersByTimeAsync(0);
      }
      return { bucket, fileClient };
    }

    it('uploads exact equal multipart parts and a smaller final part', async () => {
      const source = Uint8Array.from(
        { length: partBytes * 2 + 8 },
        (_, index) => index
      );
      const chunks: Uint8Array[] = [];
      const chunkBytes = 7;
      for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
        chunks.push(source.subarray(offset, offset + chunkBytes));
      }

      const { bucket, fileClient } = await uploadFileViaWatch(chunks);
      const [upload] = bucket.multipartUploads;

      expect(fileClient.readFile).toHaveBeenCalledWith(
        '/mnt/data/archive.bin',
        { encoding: 'none' }
      );
      expect(bucket.put).not.toHaveBeenCalled();
      expect(upload.parts.map((part) => part.bytes.byteLength)).toEqual([
        partBytes,
        partBytes,
        8
      ]);
      expect(concatBytes(upload.parts.map((part) => part.bytes))).toEqual(
        source
      );
      expect(upload.completed).toBe(true);
      expect(upload.aborted).toBe(false);
    });
    it('preserves non-UTF-8 bytes regardless of file MIME type', async () => {
      const source = Uint8Array.from([0x80, 0xff, 0x00, 0x41]);
      const { bucket } = await uploadFileViaWatch([source]);

      expect(bucket.put).toHaveBeenCalledWith('archive.bin', source);
    });
    it('aborts a multipart upload when a part fails', async () => {
      const source = new Uint8Array(partBytes * 2 + 1);
      const sourceCancel = vi.fn();
      const { bucket } = await uploadFileViaWatch([source], {
        failUploadPart: 2,
        onStreamCancel: sourceCancel
      });
      const [upload] = bucket.multipartUploads;

      expect(upload.aborted).toBe(true);
      expect(upload.completed).toBe(false);
      expect(bucket.put).not.toHaveBeenCalled();
      expect(sourceCancel).toHaveBeenCalled();
    });
  });

  describe('upload debounce', () => {
    it('collapses a write burst into one upload', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      for (const eventType of ['create', 'modify', 'modify']) {
        watch.emit({
          type: 'event',
          eventType,
          path: '/mnt/data/archive.tar',
          isDirectory: false,
          timestamp: new Date().toISOString()
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS - 500);
      }
      expect(fileClient.readFile).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(fileClient.readFile).toHaveBeenCalledTimes(1);
      expect(bucket.put).toHaveBeenCalledTimes(1);
      watch.close();
      await manager.stop();
    });

    it('retries a failed upload without another watch event', async () => {
      const bucket = createMockR2Bucket(new Map());
      bucket.put
        .mockRejectedValueOnce(new Error('temporary upload failure'))
        .mockResolvedValue(null);
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/retry.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(2);
      watch.close();
      await manager.stop();
    });

    it('lets a delete supersede a failed upload retry', async () => {
      const bucket = createMockR2Bucket(new Map());
      bucket.put.mockRejectedValueOnce(new Error('temporary upload failure'));
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/retry.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(1);

      watch.emit({
        type: 'event',
        eventType: 'delete',
        path: '/mnt/data/retry.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bucket.delete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(1);
      watch.close();
      await manager.stop();
    });

    it('retries a failed delete without another watch event', async () => {
      const bucket = createMockR2Bucket(new Map());
      bucket.delete
        .mockRejectedValueOnce(new Error('temporary delete failure'))
        .mockResolvedValue(undefined);
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      watch.emit({
        type: 'event',
        eventType: 'delete',
        path: '/mnt/data/retry.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bucket.delete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.delete).toHaveBeenCalledTimes(2);
      watch.close();
      await manager.stop();
    });

    it('serializes uploads across paths', async () => {
      const bucket = createMockR2Bucket(new Map());
      const firstPutRelease = deferred<R2Object | null>();
      bucket.put
        .mockImplementationOnce(async () => firstPutRelease.promise)
        .mockResolvedValue(null);
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/serial-a.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(1);

      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/serial-b.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(1);

      firstPutRelease.resolve(null);
      await vi.waitFor(() => expect(bucket.put).toHaveBeenCalledTimes(2));
      watch.close();
      await manager.stop();
    });

    it('waits for an active upload before deleting its object', async () => {
      const bucket = createMockR2Bucket(new Map());
      const putRelease = deferred<R2Object | null>();
      bucket.put.mockImplementationOnce(async () => putRelease.promise);
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/active.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalledTimes(1);

      watch.emit({
        type: 'event',
        eventType: 'delete',
        path: '/mnt/data/active.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bucket.delete).not.toHaveBeenCalled();

      putRelease.resolve(null);
      await vi.waitFor(() =>
        expect(bucket.delete).toHaveBeenCalledWith('active.bin')
      );
      watch.close();
      await manager.stop();
    });

    it('cancels a queued upload when the file is deleted', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/scratch.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      watch.emit({
        type: 'event',
        eventType: 'delete',
        path: '/mnt/data/scratch.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);

      expect(bucket.delete).toHaveBeenCalledWith('scratch.bin');
      expect(fileClient.readFile).not.toHaveBeenCalled();
      expect(bucket.put).not.toHaveBeenCalled();
      watch.close();
      await manager.stop();
    });
  });

  describe('stop', () => {
    it('should stop polling and clean up', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watchClient = createMockWatchClient();
      const client = createMockControlClient(fileClient, watchClient);

      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
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

    it('flushes uploads still waiting for the debounce', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();

      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/pending.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      const stop = manager.stop();
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      await stop;

      expect(fileClient.readFile).toHaveBeenCalledWith(
        '/mnt/data/pending.bin',
        {
          encoding: 'none'
        }
      );
      expect(bucket.put).toHaveBeenCalledWith(
        'pending.bin',
        encoder.encode('file-content')
      );
    });

    it('bounds graceful stop when a file stream stalls', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      fileClient.readFile.mockResolvedValue({
        success: true,
        content: new ReadableStream<Uint8Array>({ start() {} }),
        path: '/mnt/data/stalled.bin',
        size: 1,
        mimeType: 'application/octet-stream',
        timestamp: new Date().toISOString()
      });
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();
      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/stalled.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(fileClient.readFile).toHaveBeenCalled();

      let stopped = false;
      const stop = manager.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      await stop;

      expect(stopped).toBe(true);
    });

    it('does not commit a complete-sized stream canceled by stop', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const sourceCancel = vi.fn();
      const bytes = encoder.encode('file-content');
      fileClient.readFile.mockResolvedValue({
        success: true,
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
          },
          cancel: sourceCancel
        }),
        path: '/mnt/data/stalled.bin',
        size: bytes.byteLength,
        mimeType: 'application/octet-stream',
        timestamp: new Date().toISOString()
      });
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();
      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/stalled.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(fileClient.readFile).toHaveBeenCalled();

      const stop = manager.stop();
      await vi.advanceTimersByTimeAsync(5000);
      await stop;
      await vi.advanceTimersByTimeAsync(0);

      expect(sourceCancel).toHaveBeenCalledTimes(1);
      expect(bucket.put).not.toHaveBeenCalled();
    });

    it('cancels a file stream acquired after stop', async () => {
      const bucket = createMockR2Bucket(new Map());
      const fileClient = createMockFileClient();
      const fileRead = deferred<{
        success: true;
        content: ReadableStream<Uint8Array>;
        path: string;
        size: number;
        mimeType: string;
        timestamp: string;
      }>();
      fileClient.readFile.mockImplementation(() => fileRead.promise);
      const watch = createControllableWatchClient();
      const client = createMockControlClient(fileClient, watch.client);
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();
      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/late.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(fileClient.readFile).toHaveBeenCalled();

      const stop = manager.stop();
      await vi.advanceTimersByTimeAsync(5000);
      await stop;

      const sourceCancel = vi.fn();
      fileRead.resolve({
        success: true,
        content: new ReadableStream<Uint8Array>({
          start() {},
          cancel: sourceCancel
        }),
        path: '/mnt/data/late.bin',
        size: 1,
        mimeType: 'application/octet-stream',
        timestamp: new Date().toISOString()
      });
      await vi.waitFor(() => expect(sourceCancel).toHaveBeenCalledTimes(1));
      expect(bucket.put).not.toHaveBeenCalled();
    });

    it('bounds graceful stop when an R2 upload stalls', async () => {
      const bucket = createMockR2Bucket(new Map());
      bucket.put.mockImplementation(() => new Promise(() => {}));
      const fileClient = createMockFileClient();
      const watch = createControllableWatchClient();
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: false,
        runRuntimeCall: async (_operation, call) =>
          call(createMockControlClient(fileClient, watch.client)),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 60_000
      });
      await manager.start();
      watch.emit({
        type: 'event',
        eventType: 'modify',
        path: '/mnt/data/stalled.bin',
        isDirectory: false,
        timestamp: new Date().toISOString()
      });
      await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS);
      expect(bucket.put).toHaveBeenCalled();

      const stop = manager.stop();
      await vi.advanceTimersByTimeAsync(5000);
      await stop;
    });

    it('cancels a stalled small R2 download', async () => {
      const r2Objects = new Map([['small.bin', { body: 'x', etag: 'small' }]]);
      const bucket = createMockR2Bucket(r2Objects);
      const sourceCancel = vi.fn();
      bucket.get.mockResolvedValue({
        key: 'small.bin',
        etag: 'small',
        size: 1,
        body: new ReadableStream<Uint8Array>({
          start() {},
          cancel: sourceCancel
        }),
        arrayBuffer: vi.fn()
      } as unknown as R2ObjectBody);
      const fileClient = createMockFileClient();
      const client = createMockControlClient(
        fileClient,
        createMockWatchClient()
      );
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 1000
      });

      const start = manager.start();
      const startResult = expect(start).rejects.toThrow(
        'local mount sync stopped'
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bucket.get).toHaveBeenCalledWith('small.bin');

      await manager.stop();
      await startResult;

      expect(sourceCancel).toHaveBeenCalledTimes(1);
      expect(fileClient.writeFile).not.toHaveBeenCalled();
    });

    it('bounds graceful stop and cancels a stalled R2 download', async () => {
      const r2Objects = new Map<string, { body: string; etag: string }>();
      const bucket = createMockR2Bucket(r2Objects);
      const sourceCancel = vi.fn();
      bucket.get.mockResolvedValue({
        key: 'large.bin',
        etag: 'large',
        size: 4 * 1024 * 1024 + 1,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1));
          },
          cancel: sourceCancel
        }),
        arrayBuffer: vi.fn()
      } as unknown as R2ObjectBody);
      const fileClient = createMockFileClient();
      fileClient.writeFileStream.mockImplementation(
        () => new Promise(() => {})
      );
      const client = createMockControlClient(
        fileClient,
        createMockWatchClient()
      );
      const manager = new LocalMountSyncManager({
        bucket: bucket as unknown as R2Bucket,
        mountPath: '/mnt/data',
        prefix: undefined,
        readOnly: true,
        runRuntimeCall: async (_operation, call) => call(client),
        logger,
        runtimeHold: { release: () => {} },
        pollIntervalMs: 1000
      });
      await manager.start();
      r2Objects.set('large.bin', {
        body: 'x'.repeat(4 * 1024 * 1024 + 1),
        etag: 'large'
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fileClient.writeFileStream).toHaveBeenCalled();

      const stop = manager.stop();
      await vi.advanceTimersByTimeAsync(5000);
      await stop;
      await vi.advanceTimersByTimeAsync(0);

      expect(sourceCancel).toHaveBeenCalledTimes(1);
    });
  });
});
