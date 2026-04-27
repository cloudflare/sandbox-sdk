import { describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';
import {
  r2EgressHandler,
  revokeBucketAccess
} from '../src/storage-mount/r2-egress-handler';

vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: unknown;
    env: unknown;
    sleepAfter: string | number = '10m';

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    async fetch(): Promise<Response> {
      return new Response('Mock Container fetch');
    }

    async destroy(): Promise<void> {}

    async getState() {
      return { status: 'healthy' };
    }

    renewActivityTimeout() {}
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

function createMockCtx() {
  return {
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
    }
  };
}

function createMockR2Bucket(): R2Bucket {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => ({
      key: 'ignored',
      size: 0,
      etag: 'etag',
      httpEtag: '"etag"',
      uploaded: new Date('2024-01-01T00:00:00Z'),
      httpMetadata: {},
      customMetadata: {},
      storageClass: 'Standard'
    })),
    head: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({
      objects: [],
      truncated: false,
      delimitedPrefixes: []
    })),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn()
  } as unknown as R2Bucket;
}

describe('Sandbox R2 egress mounts', () => {
  it('registers bucket access before s3fs mount and applies required R2 options', async () => {
    const mockCtx = createMockCtx();
    const mockEnv = {
      MY_BUCKET: createMockR2Bucket()
    };

    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      mockEnv
    );

    await Promise.all(
      (mockCtx.blockConcurrencyWhile as ReturnType<typeof vi.fn>).mock.results
        .map((result) => result.value)
        .filter((value): value is Promise<unknown> => value instanceof Promise)
    );

    const setOutboundByHost = vi.fn().mockResolvedValue(undefined);
    const removeOutboundByHost = vi.fn().mockResolvedValue(undefined);
    const execInternal = vi.fn().mockImplementation(async (command: string) => {
      if (command.startsWith('mkdir -p ')) {
        return {
          success: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          command,
          timestamp: new Date().toISOString()
        };
      }

      if (command.startsWith('s3fs ')) {
        const probe = await r2EgressHandler(
          new Request('http://r2.internal/MY_BUCKET?location', {
            method: 'GET'
          }),
          mockEnv as Cloudflare.Env,
          { containerId: 'test-sandbox-id', className: 'Sandbox' }
        );
        expect(probe.status).toBe(200);
        expect(command).toContain('MY_BUCKET:/uploads');
        expect(command).toContain('url=http://r2.internal');
        expect(command).toContain('nosignrequest');
        expect(command).toContain('use_path_request_style');
        expect(command).toContain('nomixupload');
        expect(command).toContain('stat_cache_expire=1');
        expect(command).toContain(',ro');

        return {
          success: true,
          stdout: '',
          stderr: '',
          exitCode: 0,
          command,
          timestamp: new Date().toISOString()
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    Object.assign(sandbox as object, {
      setOutboundByHost,
      removeOutboundByHost,
      execInternal
    });

    try {
      await sandbox.mountBucket('MY_BUCKET', '/mnt/data', {
        prefix: '/uploads',
        readOnly: true,
        s3fsOptions: ['stat_cache_expire=1']
      } as any);
    } finally {
      revokeBucketAccess('test-sandbox-id', 'MY_BUCKET');
    }

    expect(setOutboundByHost).toHaveBeenCalledWith('r2.internal', 'r2Mount');
    expect(execInternal).toHaveBeenNthCalledWith(1, "mkdir -p '/mnt/data'");
    expect(execInternal).toHaveBeenCalledTimes(2);
    expect(removeOutboundByHost).not.toHaveBeenCalled();
  });
});
