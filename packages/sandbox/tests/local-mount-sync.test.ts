import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalMountSyncManager } from '../src/local-mount-sync';

// ---------------------------------------------------------------------------
// Helpers to build mock R2 objects
// ---------------------------------------------------------------------------

function makeR2Object(key: string, body: string, etag = `etag-${key}`) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(body).buffer as ArrayBuffer;
  return {
    key,
    etag,
    size: body.length,
    arrayBuffer: () => Promise.resolve(buffer)
  } as unknown as R2ObjectBody;
}

function makeR2Head(key: string, size: number, etag = `etag-${key}`) {
  return { key, etag, size } as unknown as R2Object;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockR2Bucket(
  objects: Map<string, { body: string; etag: string }>
) {
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
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn()
  } as unknown as R2Bucket & {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    head: ReturnType<typeof vi.fn>;
  };
  return bucket;
}

function createMockFileClient() {
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
    readFile: vi.fn(
      async (_path: string, _sid: string, opts?: { encoding?: string }) => ({
        success: true,
        content:
          opts?.encoding === 'base64' ? btoa('file-content') : 'file-content',
        path: _path,
        encoding: opts?.encoding || 'utf-8',
        size: 12,
        timestamp: new Date().toISOString()
      })
    ),
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
  } as any;
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
      await vi.waitFor(() =>
        expect(readControl.files.readFile).toHaveBeenCalled()
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

    it('should detect deleted objects on poll', async () => {
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

      // Clear initial sync calls
      fileClient.deleteFile.mockClear();

      // Remove from R2
      r2Objects.delete('file.txt');

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(1000);

      // Should detect deletion
      expect(fileClient.deleteFile).toHaveBeenCalledWith('/mnt/data/file.txt');

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

      await vi.advanceTimersByTimeAsync(0);

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
      await vi.waitFor(() => expect(bucket.put).toHaveBeenCalledTimes(1));

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
    const flush = () => vi.advanceTimersByTimeAsync(0);

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

      // Should read the file from container (base64)
      expect(fileClient.readFile).toHaveBeenCalledWith('/mnt/data/hello.txt', {
        encoding: 'base64'
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
        { encoding: 'base64' }
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
  });
});
