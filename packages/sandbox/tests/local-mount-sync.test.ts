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
        prefix: 'data/',
        readOnly: true,
        client,
        sessionId: 'test-session',
        logger
      });

      await manager.start();

      // Should list with prefix
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
