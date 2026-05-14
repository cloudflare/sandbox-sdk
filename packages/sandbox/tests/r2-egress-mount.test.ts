import { describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';
import {
  type R2EgressParams,
  r2EgressHandler
} from '../src/storage-mount/r2-egress-handler';

vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const outboundHandlersRegistry = new Map<string, Record<string, unknown>>();
  const outboundByHostRegistry = new Map<string, Record<string, unknown>>();

  const MockContainer = class Container {
    ctx: unknown;
    env: unknown;
    sleepAfter: string | number = '10m';

    static get outboundHandlers(): Record<string, unknown> | undefined {
      return outboundHandlersRegistry.get(Container.name);
    }

    static set outboundHandlers(handlers: Record<string, unknown>) {
      const existing = outboundHandlersRegistry.get(Container.name) ?? {};
      outboundHandlersRegistry.set(Container.name, {
        ...existing,
        ...handlers
      });
    }

    static get outboundByHost(): Record<string, unknown> | undefined {
      return outboundByHostRegistry.get(Container.name);
    }

    static set outboundByHost(handlers: Record<string, unknown>) {
      outboundByHostRegistry.set(Container.name, handlers);
    }

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

    async setOutboundByHost(_hostname: string, _method: string): Promise<void> {
      const handlers = outboundHandlersRegistry.get(this.constructor.name);
      if (!handlers || !(_method in handlers)) {
        throw new Error(
          `Outbound handler method '${_method}' not found in outboundHandlers for ${this.constructor.name}`
        );
      }
    }

    async removeOutboundByHost(_hostname: string): Promise<void> {}
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
      objects: [
        {
          key: 'data/run1/fixtures/sample.txt',
          uploaded: new Date('2024-01-01T00:00:00Z'),
          httpEtag: '"abc"',
          size: 10,
          version: 'v1',
          etag: 'abc',
          checksums: {},
          storageClass: 'Standard',
          writeHttpMetadata: () => {},
          customMetadata: {}
        }
      ],
      truncated: false,
      delimitedPrefixes: []
    })),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn()
  } as unknown as R2Bucket;
}

function createExecResult(
  command: string,
  overrides?: Partial<{ stdout: string; stderr: string; exitCode: number }>
) {
  return {
    success: (overrides?.exitCode ?? 0) === 0,
    stdout: overrides?.stdout ?? '',
    stderr: overrides?.stderr ?? '',
    exitCode: overrides?.exitCode ?? 0,
    command,
    timestamp: new Date().toISOString()
  };
}

describe('Sandbox R2 egress mounts', () => {
  it('registers the credential-less R2 outbound handler under the runtime key', async () => {
    const sandbox = new Sandbox(
      createMockCtx() as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    await expect(
      (
        sandbox as unknown as {
          setOutboundByHost: (
            hostname: string,
            method: string
          ) => Promise<void>;
        }
      ).setOutboundByHost('r2.internal', 'r2EgressMount')
    ).resolves.toBeUndefined();

    expect(
      (Sandbox as unknown as { outboundHandlers?: Record<string, unknown> })
        .outboundHandlers
    ).toMatchObject({
      r2EgressMount: r2EgressHandler
    });
  });

  describe('handler prefix translation', () => {
    it('prepends mount prefix to GET key', async () => {
      const bucket = createMockR2Bucket();
      const mockEnv = { MY_BUCKET: bucket } as unknown as Cloudflare.Env;
      const params: R2EgressParams = {
        buckets: { MY_BUCKET: { prefix: '/data/run1' } }
      };
      await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/fixtures/sample.txt'),
        mockEnv,
        { containerId: 'ctr-1', className: 'Sandbox', params }
      );
      expect(bucket.get).toHaveBeenCalledWith('data/run1/fixtures/sample.txt');
    });

    it('prepends mount prefix to list query-prefix and strips it from response keys', async () => {
      const bucket = createMockR2Bucket();
      (bucket.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        objects: [
          {
            key: 'data/run1/fixtures/sample.txt',
            uploaded: new Date('2024-01-01T00:00:00Z'),
            httpEtag: '"abc"',
            size: 10,
            version: 'v1',
            etag: 'abc',
            checksums: {},
            storageClass: 'Standard',
            writeHttpMetadata: () => {},
            customMetadata: {}
          }
        ],
        delimitedPrefixes: [],
        truncated: false
      });
      const mockEnv = { MY_BUCKET: bucket } as unknown as Cloudflare.Env;
      const params: R2EgressParams = {
        buckets: { MY_BUCKET: { prefix: '/data/run1' } }
      };
      const res = await r2EgressHandler(
        new Request(
          'http://r2.internal/MY_BUCKET/?list-type=2&prefix=fixtures%2F&delimiter=%2F'
        ),
        mockEnv,
        { containerId: 'ctr-2', className: 'Sandbox', params }
      );
      expect(bucket.list).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: 'data/run1/fixtures/' })
      );
      const xml = await res.text();
      expect(xml).toContain('<Key>fixtures/sample.txt</Key>');
      expect(xml).not.toContain('data/run1');
      expect(xml).toContain('<Prefix>fixtures/</Prefix>');
    });

    it('does not modify keys when no prefix is registered', async () => {
      const bucket = createMockR2Bucket();
      const mockEnv = { MY_BUCKET: bucket } as unknown as Cloudflare.Env;
      const params: R2EgressParams = { buckets: { MY_BUCKET: {} } };
      await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/sample.txt'),
        mockEnv,
        { containerId: 'ctr-3', className: 'Sandbox', params }
      );
      expect(bucket.get).toHaveBeenCalledWith('sample.txt');
    });

    it('strips trailing slash from prefix to avoid double-slash in key', async () => {
      const bucket = createMockR2Bucket();
      const mockEnv = { MY_BUCKET: bucket } as unknown as Cloudflare.Env;
      const params: R2EgressParams = {
        buckets: { MY_BUCKET: { prefix: '/data/run1/' } }
      };
      await r2EgressHandler(
        new Request('http://r2.internal/MY_BUCKET/file.txt'),
        mockEnv,
        { containerId: 'ctr-4', className: 'Sandbox', params }
      );
      expect(bucket.get).toHaveBeenCalledWith('data/run1/file.txt');
    });
  });

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

    const execInternal = vi.fn().mockImplementation(async (command: string) => {
      if (command.startsWith('mkdir -p ') || command.startsWith('mountpoint')) {
        return {
          success: true,
          stdout: 'FUSE_MOUNTED',
          stderr: '',
          exitCode: 0,
          command,
          timestamp: new Date().toISOString()
        };
      }

      if (command.includes('s3fs ')) {
        const params: R2EgressParams = {
          buckets: { MY_BUCKET: { prefix: '/uploads' } }
        };
        const probe = await r2EgressHandler(
          new Request('http://r2.internal/MY_BUCKET?location', {
            method: 'GET'
          }),
          mockEnv as Cloudflare.Env,
          { containerId: 'test-sandbox-id', className: 'Sandbox', params }
        );
        expect(probe.status).toBe(200);
        expect(command).toContain("'MY_BUCKET'");
        expect(command).not.toContain(':/uploads');
        expect(command).toContain('url=http://r2.internal');
        expect(command).toContain(`passwd_file=${FAKE_PASSWD}`);
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

    const FAKE_PASSWD = '/tmp/.s3fs-test-passwd';
    const createPasswordFile = vi.fn().mockResolvedValue(undefined);
    const deletePasswordFile = vi.fn().mockResolvedValue(undefined);
    const generatePasswordFilePath = vi.fn().mockReturnValue(FAKE_PASSWD);

    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile,
      deletePasswordFile,
      generatePasswordFilePath
    });

    const setOutboundByHost = vi.fn().mockResolvedValue(undefined);
    Object.assign(sandbox as object, { setOutboundByHost });

    await sandbox.mountBucket('MY_BUCKET', '/mnt/data', {
      prefix: '/uploads',
      readOnly: true,
      s3fsOptions: ['stat_cache_expire=1']
    } as any);

    expect(execInternal).toHaveBeenNthCalledWith(1, "mkdir -p '/mnt/data'");
    expect(execInternal).toHaveBeenCalledTimes(3);
    expect(setOutboundByHost).toHaveBeenCalledWith(
      'r2.internal',
      'r2EgressMount',
      { buckets: { MY_BUCKET: { prefix: '/uploads', readOnly: true } } }
    );
  });

  it('treats an empty endpoint string as a remote mount configuration error', async () => {
    const sandbox = new Sandbox(
      createMockCtx() as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/data', {
        endpoint: ''
      } as unknown as Parameters<Sandbox['mountBucket']>[2])
    ).rejects.toThrow('Invalid endpoint URL');
  });

  it('rejects a second mount of the same R2 binding with a different prefix', async () => {
    const sandbox = new Sandbox(
      createMockCtx() as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    const execInternal = vi.fn(async (command: string) => {
      if (command.startsWith('mkdir -p ')) return createExecResult(command);
      if (command.includes('s3fs ')) return createExecResult(command);
      if (command.startsWith('mountpoint')) {
        return createExecResult(command, { stdout: 'FUSE_MOUNTED' });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi
        .fn()
        .mockReturnValueOnce('/tmp/.s3fs-one')
        .mockReturnValueOnce('/tmp/.s3fs-two'),
      setOutboundByHost: vi.fn().mockResolvedValue(undefined),
      removeOutboundByHost: vi.fn().mockResolvedValue(undefined)
    });

    await sandbox.mountBucket('MY_BUCKET', '/mnt/one', {
      prefix: '/one'
    } as any);

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/two', {
        prefix: '/two'
      } as any)
    ).rejects.toThrow('already mounted');
  });

  it('deletes the password file when R2 egress mount fails', async () => {
    const sandbox = new Sandbox(
      createMockCtx() as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    const execInternal = vi.fn(async (command: string) => {
      if (command.startsWith('mkdir -p ')) return createExecResult(command);
      if (command.includes('s3fs ')) {
        return createExecResult(command, {
          exitCode: 1,
          stderr: 'mount failed'
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const deletePasswordFile = vi.fn().mockResolvedValue(undefined);
    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile,
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-failed'),
      setOutboundByHost: vi.fn().mockResolvedValue(undefined),
      removeOutboundByHost: vi.fn().mockResolvedValue(undefined)
    });

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/fail', {} as any)
    ).rejects.toThrow('S3FS mount failed');

    expect(deletePasswordFile).toHaveBeenCalledWith('/tmp/.s3fs-failed');
  });

  it('throws when s3fs exits 0 but mountpoint check does not confirm mount', async () => {
    const sandbox = new Sandbox(
      createMockCtx() as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    const deletePasswordFile = vi.fn().mockResolvedValue(undefined);
    Object.assign(sandbox as object, {
      execInternal: vi.fn(async (command: string) => {
        if (command.startsWith('mkdir -p ')) return createExecResult(command);
        if (command.includes('s3fs ')) return createExecResult(command);
        if (command.startsWith('mountpoint')) {
          return createExecResult(command, { stdout: 'NOT_FUSE_MOUNTED' });
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile,
      generatePasswordFilePath: vi
        .fn()
        .mockReturnValue('/tmp/.s3fs-check-fail'),
      setOutboundByHost: vi.fn().mockResolvedValue(undefined),
      removeOutboundByHost: vi.fn().mockResolvedValue(undefined)
    });

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/check-fail', {} as any)
    ).rejects.toThrow('mount was not established');

    expect(deletePasswordFile).toHaveBeenCalledWith('/tmp/.s3fs-check-fail');
  });

  it.each(['passwd_file=/tmp/creds', 'url=https://example.com'])(
    'rejects protected s3fs option override: %s',
    async (option) => {
      const sandbox = new Sandbox(
        createMockCtx() as unknown as ConstructorParameters<typeof Sandbox>[0],
        { MY_BUCKET: createMockR2Bucket() }
      );

      const createPasswordFile = vi.fn().mockResolvedValue(undefined);
      Object.assign(sandbox as object, {
        execInternal: vi.fn(),
        createPasswordFile,
        deletePasswordFile: vi.fn().mockResolvedValue(undefined),
        generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-unused'),
        setOutboundByHost: vi.fn().mockResolvedValue(undefined),
        removeOutboundByHost: vi.fn().mockResolvedValue(undefined)
      });

      await expect(
        sandbox.mountBucket('MY_BUCKET', '/mnt/data', {
          s3fsOptions: [option]
        } as any)
      ).rejects.toThrow('cannot be overridden');

      expect(createPasswordFile).not.toHaveBeenCalled();
    }
  );
});
