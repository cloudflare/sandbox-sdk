import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, Sandbox } from '../src/sandbox';

vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const mockSwitchPort = vi.fn((request: Request, port: number) => {
    const url = new URL(request.url);
    url.pathname = `/proxy/${port}${url.pathname}`;
    return new Request(url, request);
  });

  const MockContainer = class Container {
    ctx: any;
    env: any;
    sleepAfter: string | number = '10m';
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
      return new Response('Mock Container fetch');
    }
    async containerFetch(request: Request, port: number): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }
    async getState() {
      return { status: 'healthy' };
    }
    renewActivityTimeout() {}
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: mockSwitchPort
  };
});

// Mock R2 bucket binding
function createMockR2Bucket() {
  const store = new Map<string, { data: ArrayBuffer; size: number }>();
  return {
    put: vi.fn(async (key: string, data: string | ArrayBuffer | Uint8Array) => {
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else if (data instanceof Uint8Array) {
        bytes = new Uint8Array(data);
      } else {
        bytes = new Uint8Array(data);
      }
      const buffer = bytes.buffer as ArrayBuffer;
      store.set(key, { data: buffer, size: bytes.byteLength });
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        arrayBuffer: async () => entry.data,
        json: async <T>() =>
          JSON.parse(new TextDecoder().decode(entry.data)) as T,
        text: async () => new TextDecoder().decode(entry.data)
      };
    }),
    head: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return { size: entry.size };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    _store: store
  };
}

interface MockCtx {
  storage: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  blockConcurrencyWhile: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  id: {
    toString: () => string;
    equals: ReturnType<typeof vi.fn>;
    name: string;
  };
}

describe('Local Backup & Restore', () => {
  let sandbox: Sandbox;
  let mockCtx: MockCtx;
  let mockEnv: Record<string, unknown>;
  let mockBucket: ReturnType<typeof createMockR2Bucket>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockBucket = createMockR2Bucket();

    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map())
      },
      blockConcurrencyWhile: vi
        .fn()
        .mockImplementation(
          <T>(callback: () => Promise<T>): Promise<T> => callback()
        ),
      waitUntil: vi.fn(),
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox'
      } as any
    };

    mockEnv = {
      BACKUP_BUCKET: mockBucket
    };

    const stub = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      mockEnv
    );

    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    sandbox = Object.assign(stub, {
      wsConnect: connect(stub)
    });

    // Mock session creation
    vi.spyOn(sandbox.client.utils, 'createSession').mockResolvedValue({
      success: true,
      id: 'sandbox-default',
      message: 'Created'
    } as any);

    vi.spyOn(sandbox.client.utils, 'deleteSession').mockResolvedValue({
      success: true,
      sessionId: 'sandbox-default',
      timestamp: new Date().toISOString()
    } as any);

    // Mock command execution (for exec, rm, mkdir, unsquashfs)
    vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      command: '',
      timestamp: new Date().toISOString()
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createBackup with localBucket', () => {
    it('should create a backup using R2 binding', async () => {
      // Mock createArchive
      const archiveContent = new Uint8Array([0x68, 0x73, 0x71, 0x73]); // "hsqs" squashfs magic

      vi.spyOn(sandbox.client.backup, 'createArchive').mockResolvedValue({
        success: true,
        archivePath: '/var/backups/test.sqsh',
        sizeBytes: archiveContent.length
      } as any);
      const ssePayload = [
        `data: ${JSON.stringify({ type: 'metadata', mimeType: 'application/octet-stream', size: archiveContent.length, isBinary: true, encoding: 'base64' })}\n\n`,
        `data: ${JSON.stringify({ type: 'chunk', data: btoa(String.fromCharCode(...archiveContent)) })}\n\n`,
        `data: ${JSON.stringify({ type: 'complete' })}\n\n`
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload));
          controller.close();
        }
      });

      vi.spyOn(sandbox.client.files, 'readFileStream').mockResolvedValue(
        stream
      );

      const result = await sandbox.createBackup({
        dir: '/workspace/myapp',
        name: 'test-backup',
        ttl: 3600,
        localBucket: true
      });

      expect(result.id).toBeDefined();
      expect(result.dir).toBe('/workspace/myapp');
      expect(result.localBucket).toBe(true);

      // Verify archive was created in the container
      expect(sandbox.client.backup.createArchive).toHaveBeenCalledWith(
        '/workspace/myapp',
        expect.stringContaining('/var/backups/'),
        expect.any(String), // backup session ID
        { gitignore: false, excludes: [] }
      );

      // Verify archive was uploaded to R2 via binding
      expect(mockBucket.put).toHaveBeenCalledWith(
        expect.stringMatching(/^backups\/.*\/data\.sqsh$/),
        expect.any(Uint8Array)
      );

      // Verify metadata was written
      expect(mockBucket.put).toHaveBeenCalledWith(
        expect.stringMatching(/^backups\/.*\/meta\.json$/),
        expect.stringContaining('"dir":"/workspace/myapp"')
      );

      // Verify upload was verified
      expect(mockBucket.head).toHaveBeenCalled();
    });

    it('should throw if BACKUP_BUCKET binding is missing', async () => {
      // Remove the BACKUP_BUCKET binding
      (sandbox as any).env = {};

      await expect(
        sandbox.createBackup({
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('BACKUP_BUCKET R2 binding not found');
    });

    it('should validate backup directory', async () => {
      await expect(
        sandbox.createBackup({
          dir: '/etc/secrets',
          localBucket: true
        })
      ).rejects.toThrow('supported backup roots');
    });

    it('should validate relative paths', async () => {
      await expect(
        sandbox.createBackup({
          dir: 'relative/path',
          localBucket: true
        })
      ).rejects.toThrow('absolute path');
    });

    it('should validate path traversal', async () => {
      await expect(
        sandbox.createBackup({
          dir: '/workspace/../../../etc/passwd',
          localBucket: true
        })
      ).rejects.toThrow('..');
    });

    it('should clean up on archive creation failure', async () => {
      vi.spyOn(sandbox.client.backup, 'createArchive').mockResolvedValue({
        success: false,
        archivePath: '',
        sizeBytes: 0
      } as any);

      await expect(
        sandbox.createBackup({
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('Container failed to create backup archive');

      // Verify session was cleaned up
      expect(sandbox.client.utils.deleteSession).toHaveBeenCalled();
    });

    it('should not require presigned URL credentials', async () => {
      vi.spyOn(sandbox.client.backup, 'createArchive').mockResolvedValue({
        success: true,
        archivePath: '/var/backups/test.sqsh',
        sizeBytes: 4
      } as any);

      const archiveContent = new Uint8Array([0x68, 0x73, 0x71, 0x73]);
      const ssePayload = [
        `data: ${JSON.stringify({ type: 'metadata', mimeType: 'application/octet-stream', size: archiveContent.length, isBinary: true, encoding: 'base64' })}\n\n`,
        `data: ${JSON.stringify({ type: 'chunk', data: btoa(String.fromCharCode(...archiveContent)) })}\n\n`,
        `data: ${JSON.stringify({ type: 'complete' })}\n\n`
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload));
          controller.close();
        }
      });

      vi.spyOn(sandbox.client.files, 'readFileStream').mockResolvedValue(
        stream
      );

      // Should succeed without R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, etc.
      const result = await sandbox.createBackup({
        dir: '/workspace/myapp',
        localBucket: true
      });

      expect(result.id).toBeDefined();
      expect(result.localBucket).toBe(true);
    });

    it('should normalize globstar excludes before calling createArchive', async () => {
      vi.spyOn(sandbox.client.backup, 'createArchive').mockResolvedValue({
        success: true,
        archivePath: '/var/backups/test.sqsh',
        sizeBytes: 4
      } as any);

      const archiveContent = new Uint8Array([0x68, 0x73, 0x71, 0x73]);
      const ssePayload = [
        `data: ${JSON.stringify({ type: 'metadata', mimeType: 'application/octet-stream', size: archiveContent.length, isBinary: true, encoding: 'base64' })}\n\n`,
        `data: ${JSON.stringify({ type: 'chunk', data: btoa(String.fromCharCode(...archiveContent)) })}\n\n`,
        `data: ${JSON.stringify({ type: 'complete' })}\n\n`
      ].join('');

      vi.spyOn(sandbox.client.files, 'readFileStream').mockResolvedValue(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(ssePayload));
            controller.close();
          }
        })
      );

      await sandbox.createBackup({
        dir: '/workspace/myapp',
        localBucket: true,
        excludes: ['**/node_modules/.cache', '**/.next/cache', 'dist/**', '**']
      });

      expect(sandbox.client.backup.createArchive).toHaveBeenCalledWith(
        '/workspace/myapp',
        expect.stringContaining('/var/backups/'),
        expect.any(String),
        {
          gitignore: false,
          excludes: ['node_modules/.cache', '.next/cache', 'dist']
        }
      );
    });
  });

  describe('restoreBackup with localBucket', () => {
    it('should restore a backup using R2 binding and unsquashfs', async () => {
      // Pre-populate R2 with backup data
      const archiveData = new Uint8Array([0x68, 0x73, 0x71, 0x73]);
      const metadata = {
        id: '12345678-1234-1234-1234-123456789012',
        dir: '/workspace/myapp',
        name: 'test-backup',
        sizeBytes: archiveData.length,
        ttl: 3600,
        createdAt: new Date().toISOString()
      };

      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/meta.json',
        JSON.stringify(metadata)
      );
      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/data.sqsh',
        archiveData
      );

      // Mock writeFile for writing archive to container
      vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
        success: true,
        path: '/var/backups/test.sqsh',
        timestamp: new Date().toISOString()
      } as any);

      const result = await sandbox.restoreBackup({
        id: '12345678-1234-1234-1234-123456789012',
        dir: '/workspace/myapp',
        localBucket: true
      });

      expect(result.success).toBe(true);
      expect(result.dir).toBe('/workspace/myapp');
      expect(result.id).toBe('12345678-1234-1234-1234-123456789012');

      // Verify archive was downloaded from R2 via binding
      expect(mockBucket.get).toHaveBeenCalledWith(
        'backups/12345678-1234-1234-1234-123456789012/data.sqsh'
      );

      // Verify archive was written to container
      expect(sandbox.client.files.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('/var/backups/'),
        expect.any(String), // base64 content
        expect.any(String), // session ID
        { encoding: 'base64' }
      );

      // Verify unsquashfs was called
      const execCalls = vi.mocked(sandbox.client.commands.execute).mock.calls;
      const unsquashfsCall = execCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('unsquashfs')
      );
      expect(unsquashfsCall).toBeDefined();
      expect(unsquashfsCall![0]).toContain('/usr/bin/unsquashfs');
      expect(unsquashfsCall![0]).toContain('/workspace/myapp');
    });

    it('should throw if BACKUP_BUCKET binding is missing for restore', async () => {
      (sandbox as any).env = {};

      await expect(
        sandbox.restoreBackup({
          id: '12345678-1234-1234-1234-123456789012',
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('BACKUP_BUCKET R2 binding not found');
    });

    it('should throw for invalid backup ID format', async () => {
      await expect(
        sandbox.restoreBackup({
          id: 'not-a-valid-uuid',
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('valid UUID');
    });

    it('should throw for non-existent backup', async () => {
      await expect(
        sandbox.restoreBackup({
          id: '00000000-0000-0000-0000-000000000000',
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('Backup not found');
    });

    it('should throw for expired backup', async () => {
      const metadata = {
        id: '12345678-1234-1234-1234-123456789012',
        dir: '/workspace/myapp',
        name: null,
        sizeBytes: 100,
        ttl: 1, // 1 second TTL
        createdAt: new Date(Date.now() - 120_000).toISOString() // 2 minutes ago
      };

      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/meta.json',
        JSON.stringify(metadata)
      );

      await expect(
        sandbox.restoreBackup({
          id: '12345678-1234-1234-1234-123456789012',
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('expired');
    });

    it('should clean up archive after successful extraction', async () => {
      const archiveData = new Uint8Array([0x68, 0x73, 0x71, 0x73]);
      const metadata = {
        id: '12345678-1234-1234-1234-123456789012',
        dir: '/workspace/myapp',
        name: null,
        sizeBytes: archiveData.length,
        ttl: 3600,
        createdAt: new Date().toISOString()
      };

      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/meta.json',
        JSON.stringify(metadata)
      );
      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/data.sqsh',
        archiveData
      );

      vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
        success: true,
        path: '/var/backups/test.sqsh',
        timestamp: new Date().toISOString()
      } as any);

      await sandbox.restoreBackup({
        id: '12345678-1234-1234-1234-123456789012',
        dir: '/workspace/myapp',
        localBucket: true
      });

      // Verify cleanup rm -f was called for the archive
      const execCalls = vi.mocked(sandbox.client.commands.execute).mock.calls;
      const rmCall = execCalls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('rm -f') &&
          call[0].includes('.sqsh')
      );
      expect(rmCall).toBeDefined();
    });

    it('should handle unsquashfs failure', async () => {
      const archiveData = new Uint8Array([0x68, 0x73, 0x71, 0x73]);
      const metadata = {
        id: '12345678-1234-1234-1234-123456789012',
        dir: '/workspace/myapp',
        name: null,
        sizeBytes: archiveData.length,
        ttl: 3600,
        createdAt: new Date().toISOString()
      };

      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/meta.json',
        JSON.stringify(metadata)
      );
      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/data.sqsh',
        archiveData
      );

      vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
        success: true,
        path: '/var/backups/test.sqsh',
        timestamp: new Date().toISOString()
      } as any);

      // Make unsquashfs fail
      vi.mocked(sandbox.client.commands.execute).mockImplementation(
        async (command: string) => {
          if (command.includes('unsquashfs')) {
            return {
              success: false,
              stdout: '',
              stderr: 'unsquashfs: bad archive',
              exitCode: 1,
              command,
              timestamp: new Date().toISOString()
            } as any;
          }
          return {
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            command,
            timestamp: new Date().toISOString()
          } as any;
        }
      );

      await expect(
        sandbox.restoreBackup({
          id: '12345678-1234-1234-1234-123456789012',
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('unsquashfs extraction failed');
    });

    it('should surface archive write failures before running unsquashfs', async () => {
      const archiveData = new Uint8Array([0x68, 0x73, 0x71, 0x73]);
      const metadata = {
        id: '12345678-1234-1234-1234-123456789012',
        dir: '/workspace/myapp',
        name: null,
        sizeBytes: archiveData.length,
        ttl: 3600,
        createdAt: new Date().toISOString()
      };

      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/meta.json',
        JSON.stringify(metadata)
      );
      await mockBucket.put(
        'backups/12345678-1234-1234-1234-123456789012/data.sqsh',
        archiveData
      );

      vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
        success: false,
        error: {
          message: "Failed to write file '/var/backups/test.sqsh': disk full"
        }
      } as any);

      await expect(
        sandbox.restoreBackup({
          id: '12345678-1234-1234-1234-123456789012',
          dir: '/workspace/myapp',
          localBucket: true
        })
      ).rejects.toThrow('Failed to write backup archive');

      const execCalls = vi.mocked(sandbox.client.commands.execute).mock.calls;
      const unsquashfsCall = execCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('unsquashfs')
      );
      expect(unsquashfsCall).toBeUndefined();
    });
  });

  describe('localBucket round-trip', () => {
    it('should round-trip localBucket through DirectoryBackup', async () => {
      vi.spyOn(sandbox.client.backup, 'createArchive').mockResolvedValue({
        success: true,
        archivePath: '/var/backups/test.sqsh',
        sizeBytes: 4
      } as any);

      const archiveContent = new Uint8Array([0x68, 0x73, 0x71, 0x73]);
      const ssePayload = [
        `data: ${JSON.stringify({ type: 'metadata', mimeType: 'application/octet-stream', size: archiveContent.length, isBinary: true, encoding: 'base64' })}\n\n`,
        `data: ${JSON.stringify({ type: 'chunk', data: btoa(String.fromCharCode(...archiveContent)) })}\n\n`,
        `data: ${JSON.stringify({ type: 'complete' })}\n\n`
      ].join('');

      vi.spyOn(sandbox.client.files, 'readFileStream').mockResolvedValue(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(ssePayload));
            controller.close();
          }
        })
      );

      vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
        success: true,
        path: '/var/backups/test.sqsh',
        timestamp: new Date().toISOString()
      } as any);

      // Create backup with localBucket
      const backup = await sandbox.createBackup({
        dir: '/workspace/myapp',
        localBucket: true
      });

      expect(backup.localBucket).toBe(true);

      // Restore using the same handle — should use local path
      const result = await sandbox.restoreBackup(backup);

      expect(result.success).toBe(true);

      // Verify unsquashfs was used (local path), not presigned URLs
      const execCalls = vi.mocked(sandbox.client.commands.execute).mock.calls;
      const unsquashfsCall = execCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('unsquashfs')
      );
      expect(unsquashfsCall).toBeDefined();

      // Verify no curl calls (production uses curl for presigned URLs)
      const curlCall = execCalls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('curl')
      );
      expect(curlCall).toBeUndefined();
    });

    it('should use production path when localBucket is not set', async () => {
      // Without localBucket, createBackup should try the production path
      // which requires backupBucket and presigned URL support
      await expect(
        sandbox.createBackup({
          dir: '/workspace/myapp'
        })
      ).rejects.toThrow('BACKUP_BUCKET');
    });
  });
});
