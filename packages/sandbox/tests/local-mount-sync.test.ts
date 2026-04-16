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
  watchClient: ReturnType<typeof createMockWatchClient>
) {
  return {
    files: fileClient,
    watch: watchClient
  } as any;
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

      await vi.advanceTimersByTimeAsync(0);

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

      await flush();

      // Should read the file from container (base64)
      expect(fileClient.readFile).toHaveBeenCalledWith(
        '/mnt/data/hello.txt',
        'test-session',
        { encoding: 'base64' }
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

      await flush();

      expect(fileClient.readFile).toHaveBeenCalledWith(
        '/mnt/data/existing.txt',
        'test-session',
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
