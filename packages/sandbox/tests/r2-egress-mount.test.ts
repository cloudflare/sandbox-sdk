import { describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';
import {
  type R2EgressParams,
  r2EgressHandler
} from '../src/storage-mount/r2-egress-handler';

type MockFetcher = {
  fetch: ReturnType<typeof vi.fn>;
};

type TestOutboundHandlerContext = {
  containerId: string;
  className: string;
  params?: unknown;
};

type TestOutboundHandler = (
  request: Request,
  env: Cloudflare.Env,
  ctx: TestOutboundHandlerContext
) => Response | Promise<Response>;

type TestOutboundHostOverride = {
  method: string;
  params?: unknown;
};

type TestContainerProxyOptions = {
  props: {
    containerId: string;
    className: string;
    outboundByHostOverrides?: Record<string, TestOutboundHostOverride>;
  };
};

const testOutboundHandlersRegistry = vi.hoisted(
  () => new Map<string, Record<string, TestOutboundHandler>>()
);

vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const outboundByHostRegistry = new Map<string, Record<string, unknown>>();

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

    async containerFetch(): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }

    async destroy(): Promise<void> {}

    async getState() {
      return { status: 'healthy' };
    }

    renewActivityTimeout() {}

    async setOutboundByHost(_hostname: string, _method: string): Promise<void> {
      const handlers = testOutboundHandlersRegistry.get(this.constructor.name);
      if (!handlers || !(_method in handlers)) {
        throw new Error(
          `Outbound handler method '${_method}' not found in outboundHandlers for ${this.constructor.name}`
        );
      }
    }

    async removeOutboundByHost(_hostname: string): Promise<void> {}
  };

  Object.defineProperty(MockContainer, 'outboundHandlers', {
    get: function (this: { name: string }) {
      return testOutboundHandlersRegistry.get(this.name);
    },
    set: function (
      this: { name: string },
      handlers: Record<string, TestOutboundHandler>
    ) {
      const existing = testOutboundHandlersRegistry.get(this.name) ?? {};
      testOutboundHandlersRegistry.set(this.name, {
        ...existing,
        ...handlers
      });
    }
  });

  Object.defineProperty(MockContainer, 'outboundByHost', {
    get: function (this: { name: string }) {
      return outboundByHostRegistry.get(this.name);
    },
    set: function (this: { name: string }, handlers: Record<string, unknown>) {
      outboundByHostRegistry.set(this.name, handlers);
    }
  });

  class MockContainerProxy extends MockContainer {}

  return {
    Container: MockContainer,
    ContainerProxy: MockContainerProxy,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

function createMockCtx(options?: {
  includeContainerProxy?: boolean;
  containerProxyResult?: unknown;
}) {
  let latestProxyOptions: TestContainerProxyOptions | undefined;
  const containerProxyFetcher = {
    fetch: vi.fn(async (request: Request) => {
      const proxyOptions = latestProxyOptions;
      if (!proxyOptions) {
        return new Response('Origin is disallowed', { status: 530 });
      }

      const hostname = new URL(request.url).hostname;
      const override = proxyOptions.props.outboundByHostOverrides?.[hostname];
      const handler = override
        ? testOutboundHandlersRegistry.get(proxyOptions.props.className)?.[
            override.method
          ]
        : undefined;

      if (!override || !handler) {
        return new Response('Origin is disallowed', { status: 530 });
      }

      return handler(
        request,
        { MY_BUCKET: createMockR2Bucket() } as unknown as Cloudflare.Env,
        {
          containerId: proxyOptions.props.containerId,
          className: proxyOptions.props.className,
          params: override.params
        }
      );
    })
  } satisfies MockFetcher;
  const ContainerProxy = vi.fn((proxyOptions: TestContainerProxyOptions) => {
    latestProxyOptions = proxyOptions;
    return options?.containerProxyResult ?? containerProxyFetcher;
  });
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
    },
    container: {
      interceptOutboundHttp: vi.fn().mockResolvedValue(undefined)
    },
    exports: options?.includeContainerProxy === false ? {} : { ContainerProxy },
    containerProxyFetcher
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

describe('Sandbox credential proxy mounts', () => {
  function createCredentialProxyExecMock() {
    return vi.fn(async (command: string) => {
      if (command.startsWith('test -d ')) return createExecResult(command);
      if (command.startsWith('mkdir -p ')) return createExecResult(command);
      if (command.includes('s3fs ')) return createExecResult(command);
      if (command.startsWith('mountpoint -q') && command.includes('echo')) {
        return createExecResult(command, { stdout: 'FUSE_MOUNTED' });
      }
      if (command.startsWith('fusermount -u ')) {
        return createExecResult(command);
      }
      if (command.startsWith('mountpoint -q') && command.includes('rmdir')) {
        return createExecResult(command);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  }

  it('registers the stable proxy host for interception on credential proxy mount', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );

    Object.assign(sandbox as object, {
      execInternal: createCredentialProxyExecMock(),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-proxy')
    });

    await sandbox.mountBucket('my-bucket', '/mnt/proxy', {
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      credentialProxy: true
    });

    expect(mockCtx.container.interceptOutboundHttp).toHaveBeenCalledWith(
      's3-credential-proxy.internal',
      mockCtx.containerProxyFetcher
    );
  });

  it('writes dummy credentials into the container for credential proxy mounts', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );
    const createPasswordFile = vi.fn().mockResolvedValue(undefined);

    Object.assign(sandbox as object, {
      execInternal: createCredentialProxyExecMock(),
      createPasswordFile,
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-dummy')
    });

    await sandbox.mountBucket('my-bucket', '/mnt/proxy', {
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'REAL_KEY', secretAccessKey: 'REAL_SECRET' },
      credentialProxy: true
    });

    expect(createPasswordFile).toHaveBeenCalledWith(
      '/tmp/.s3fs-dummy',
      'my-bucket',
      { accessKeyId: 'x', secretAccessKey: 'x' }
    );
  });

  it('appends required s3fs options for credential proxy mounts', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );
    const execInternal = createCredentialProxyExecMock();

    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi
        .fn()
        .mockReturnValue('/tmp/.s3fs-path-style'),
      generateS3FSAdditionalHeaderFilePath: vi
        .fn()
        .mockReturnValue('/tmp/.s3fs-ahbe-path-style.conf')
    });

    await sandbox.mountBucket('my-bucket', '/mnt/proxy', {
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      credentialProxy: true
    });

    const s3fsCall = execInternal.mock.calls.find((args) =>
      String(args[0]).includes('s3fs ')
    );
    expect(s3fsCall).toBeDefined();
    expect(String(s3fsCall![0])).toContain('use_path_request_style');
    expect(String(s3fsCall![0])).toContain(
      'ahbe_conf=/tmp/.s3fs-ahbe-path-style.conf'
    );
    expect(String(s3fsCall![0])).toContain('s3-credential-proxy.internal');
  });

  it('passes the mount ID as the s3fs url path segment', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );
    const execInternal = createCredentialProxyExecMock();

    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-mountid')
    });

    await sandbox.mountBucket('my-bucket', '/mnt/proxy', {
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      credentialProxy: true
    });

    const s3fsCall = execInternal.mock.calls.find((args) =>
      String(args[0]).includes('s3fs ')
    );
    const cmd = String(s3fsCall![0]);
    // url should be http://s3-credential-proxy.internal/<uuid>
    expect(cmd).toMatch(/s3-credential-proxy\.internal\/[0-9a-f-]{36}/);
  });

  it('reconfigures proxy to remove mount after unmount', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );

    Object.assign(sandbox as object, {
      execInternal: createCredentialProxyExecMock(),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi
        .fn()
        .mockReturnValue('/tmp/.s3fs-unmount-proxy')
    });

    await sandbox.mountBucket('my-bucket', '/mnt/proxy', {
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      credentialProxy: true
    });

    const ContainerProxy = mockCtx.exports.ContainerProxy!;
    const callsBeforeUnmount = ContainerProxy.mock.calls.length;
    await sandbox.unmountBucket('/mnt/proxy');

    expect(ContainerProxy.mock.calls.length).toBeGreaterThan(
      callsBeforeUnmount
    );
    const lastCall =
      ContainerProxy.mock.calls[ContainerProxy.mock.calls.length - 1];
    expect(lastCall[0].props.outboundByHostOverrides).toMatchObject({
      's3-credential-proxy.internal': { method: 's3CredentialProxyMount' }
    });
  });

  it('reconfigures proxy with empty mounts after s3fs mount failure', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );

    const execInternal = vi.fn(async (command: string) => {
      if (command.startsWith('test -d ')) return createExecResult(command);
      if (command.startsWith('mkdir -p ')) return createExecResult(command);
      if (command.includes('s3fs ')) {
        return createExecResult(command, {
          exitCode: 1,
          stderr: 'mount failed'
        });
      }
      return createExecResult(command);
    });
    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-fail-proxy')
    });

    await expect(
      sandbox.mountBucket('my-bucket', '/mnt/proxy', {
        endpoint: 'https://abc123.r2.cloudflarestorage.com',
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
        credentialProxy: true
      })
    ).rejects.toThrow();

    const ContainerProxy = mockCtx.exports.ContainerProxy!;
    const lastCall =
      ContainerProxy.mock.calls[ContainerProxy.mock.calls.length - 1];
    expect(lastCall[0].props.outboundByHostOverrides).toMatchObject({
      's3-credential-proxy.internal': {
        method: 's3CredentialProxyMount',
        params: { mounts: {} }
      }
    });
  });

  it('attempts best-effort unmount before deleting credential proxy support files on mount failure', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );

    const operationOrder: string[] = [];
    const execInternal = vi.fn(async (command: string) => {
      if (command.startsWith('test -d ')) return createExecResult(command);
      if (command.startsWith('mkdir -p ')) return createExecResult(command);
      if (command.includes('s3fs ')) {
        return createExecResult(command, {
          exitCode: 2,
          stdout: 'mount failed'
        });
      }
      if (
        command.startsWith('mountpoint -q') &&
        command.includes('fusermount')
      ) {
        operationOrder.push('unmount');
        return createExecResult(command);
      }
      if (command.startsWith('rmdir ')) return createExecResult(command);
      return createExecResult(command);
    });
    const deletePasswordFile = vi.fn().mockImplementation(async () => {
      operationOrder.push('delete-password');
    });
    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile,
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi
        .fn()
        .mockReturnValue('/tmp/.s3fs-fail-cleanup-order')
    });

    await expect(
      sandbox.mountBucket('my-bucket', '/mnt/proxy', {
        endpoint: 'https://abc123.r2.cloudflarestorage.com',
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
        credentialProxy: true
      })
    ).rejects.toThrow();

    expect(operationOrder).toEqual(['unmount', 'delete-password']);
  });

  it('clears credential proxy interception on onStop', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {}
    );

    Object.assign(sandbox as object, {
      execInternal: createCredentialProxyExecMock(),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-onstop')
    });

    await sandbox.mountBucket('my-bucket', '/mnt/proxy', {
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      credentialProxy: true
    });

    const ContainerProxy = mockCtx.exports.ContainerProxy!;
    const callsBeforeStop = ContainerProxy.mock.calls.length;

    await (sandbox as unknown as { onStop(): Promise<void> }).onStop();

    expect(ContainerProxy.mock.calls.length).toBeGreaterThan(callsBeforeStop);
    const lastCall =
      ContainerProxy.mock.calls[ContainerProxy.mock.calls.length - 1];
    expect(lastCall[0].props.outboundByHostOverrides).toMatchObject({
      's3-credential-proxy.internal': {
        method: 's3CredentialProxyMount',
        params: { mounts: {} }
      }
    });
  });

  it('rejects passwd_file and url overrides in s3fsOptions for credential proxy mounts', async () => {
    for (const option of [
      'passwd_file=/tmp/x',
      'url=https://bad.example.com'
    ]) {
      const sandbox = new Sandbox(
        createMockCtx() as unknown as ConstructorParameters<typeof Sandbox>[0],
        {}
      );
      const createPasswordFile = vi.fn().mockResolvedValue(undefined);
      Object.assign(sandbox as object, {
        execInternal: vi.fn(),
        createPasswordFile,
        deletePasswordFile: vi.fn().mockResolvedValue(undefined),
        generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-reject')
      });

      await expect(
        sandbox.mountBucket('my-bucket', '/mnt/proxy', {
          endpoint: 'https://abc123.r2.cloudflarestorage.com',
          credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
          credentialProxy: true,
          s3fsOptions: [option]
        })
      ).rejects.toThrow('cannot be overridden for credential proxy mounts');

      expect(createPasswordFile).not.toHaveBeenCalled();
    }
  });
});

describe('Sandbox R2 egress mounts', () => {
  it('does not set up outbound interception at construction time for Sandbox subclasses', () => {
    class BaseSandbox extends Sandbox {}
    const mockCtx = createMockCtx();
    new BaseSandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    expect(mockCtx.container.interceptOutboundHttp).not.toHaveBeenCalled();
    expect(mockCtx.exports.ContainerProxy).not.toHaveBeenCalled();
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
        expect(command).toContain(`ahbe_conf=${FAKE_AHBE_CONF}`);
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
    const FAKE_AHBE_CONF = '/tmp/.s3fs-ahbe-test.conf';
    const generateS3FSAdditionalHeaderFilePath = vi
      .fn()
      .mockReturnValue(FAKE_AHBE_CONF);

    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile,
      deletePasswordFile,
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath,
      generateS3FSAdditionalHeaderFilePath
    });

    await sandbox.mountBucket('MY_BUCKET', '/mnt/data', {
      prefix: '/uploads',
      readOnly: true,
      s3fsOptions: ['stat_cache_expire=1']
    } as any);

    expect(mockCtx.exports.ContainerProxy).toHaveBeenCalledWith({
      props: {
        enableInternet: undefined,
        containerId: 'test-sandbox-id',
        className: 'ContainerProxy',
        outboundByHostOverrides: {
          'r2.internal': {
            method: 'r2EgressMount',
            params: {
              buckets: { MY_BUCKET: { prefix: '/uploads', readOnly: true } }
            }
          }
        }
      }
    });
    expect(mockCtx.container.interceptOutboundHttp).toHaveBeenCalledWith(
      'r2.internal',
      mockCtx.containerProxyFetcher
    );
    const proxyResponse = await mockCtx.containerProxyFetcher.fetch(
      new Request('http://r2.internal/MY_BUCKET?location', { method: 'GET' })
    );
    expect(proxyResponse.status).toBe(200);
    expect(
      mockCtx.container.interceptOutboundHttp.mock.invocationCallOrder[0]
    ).toBeLessThan(execInternal.mock.invocationCallOrder[0]);
    expect(execInternal).toHaveBeenNthCalledWith(1, "mkdir -p '/mnt/data'");
    expect(execInternal).toHaveBeenCalledTimes(3);
  });

  it('throws a clear error when ContainerProxy is not exported for R2 binding mounts', async () => {
    const mockCtx = createMockCtx({ includeContainerProxy: false });
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    Object.assign(sandbox as object, {
      execInternal: vi.fn(),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-no-proxy')
    });

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/no-proxy', {} as any)
    ).rejects.toThrow('exporting ContainerProxy');

    expect(mockCtx.container.interceptOutboundHttp).not.toHaveBeenCalled();
  });

  it('throws a clear error when ContainerProxy does not return a fetcher', async () => {
    const mockCtx = createMockCtx({ containerProxyResult: {} });
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    Object.assign(sandbox as object, {
      execInternal: vi.fn(),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-bad-proxy')
    });

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/bad-proxy', {} as any)
    ).rejects.toThrow('valid Fetcher');

    expect(mockCtx.container.interceptOutboundHttp).not.toHaveBeenCalled();
  });

  it('isolates R2 egress from user-defined outbound handlers on Sandbox subclasses', async () => {
    class UserSandbox extends Sandbox {}
    UserSandbox.outboundHandlers = {
      userHandler: vi.fn()
    };
    UserSandbox.outboundByHost = {
      'example.com': vi.fn()
    };

    const mockCtx = createMockCtx();
    const sandbox = new UserSandbox(
      mockCtx as unknown as ConstructorParameters<typeof UserSandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    Object.assign(sandbox as object, {
      execInternal: vi.fn(async (command: string) => {
        if (command.startsWith('mkdir -p ')) return createExecResult(command);
        if (command.includes('s3fs ')) return createExecResult(command);
        if (command.startsWith('mountpoint')) {
          return createExecResult(command, { stdout: 'FUSE_MOUNTED' });
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-isolated')
    });

    await sandbox.mountBucket('MY_BUCKET', '/mnt/isolated', {} as any);

    expect(mockCtx.exports.ContainerProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({
          className: 'ContainerProxy',
          outboundByHostOverrides: {
            'r2.internal': expect.objectContaining({
              method: 'r2EgressMount'
            })
          }
        })
      })
    );
  });

  it('rejects invalid endpoint URLs for S3-compatible mounts', async () => {
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
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi
        .fn()
        .mockReturnValueOnce('/tmp/.s3fs-one')
        .mockReturnValueOnce('/tmp/.s3fs-two')
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

  it('rejects a second mount of the same R2 binding with a different readOnly setting', async () => {
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
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi
        .fn()
        .mockReturnValueOnce('/tmp/.s3fs-one')
        .mockReturnValueOnce('/tmp/.s3fs-two')
    });

    await sandbox.mountBucket('MY_BUCKET', '/mnt/one', {
      prefix: '/shared',
      readOnly: true
    } as any);

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/two', {
        prefix: '/shared',
        readOnly: false
      } as any)
    ).rejects.toThrow('different readOnly setting');
  });

  it('updates R2 egress interception to deny all buckets after final unmount', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      { MY_BUCKET: createMockR2Bucket() }
    );

    const deleteAdditionalHeaderFile = vi.fn().mockResolvedValue(undefined);
    Object.assign(sandbox as object, {
      execInternal: vi.fn(async (command: string) => {
        if (command.startsWith('mkdir -p ')) return createExecResult(command);
        if (command.includes('s3fs ')) return createExecResult(command);
        if (command.startsWith('mountpoint -q') && command.includes('echo')) {
          return createExecResult(command, { stdout: 'FUSE_MOUNTED' });
        }
        if (command.startsWith('fusermount -u ')) {
          return createExecResult(command);
        }
        if (command.startsWith('mountpoint -q') && command.includes('rmdir')) {
          return createExecResult(command);
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile: vi.fn().mockResolvedValue(undefined),
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile,
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-unmount'),
      generateS3FSAdditionalHeaderFilePath: vi
        .fn()
        .mockReturnValue('/tmp/.s3fs-ahbe-unmount.conf')
    });

    await sandbox.mountBucket('MY_BUCKET', '/mnt/data', {} as any);
    await sandbox.unmountBucket('/mnt/data');

    expect(mockCtx.exports.ContainerProxy).toHaveBeenLastCalledWith({
      props: {
        enableInternet: undefined,
        containerId: 'test-sandbox-id',
        className: 'ContainerProxy',
        outboundByHostOverrides: {
          'r2.internal': {
            method: 'r2EgressMount',
            params: { buckets: {} }
          }
        }
      }
    });
    expect(mockCtx.container.interceptOutboundHttp).toHaveBeenLastCalledWith(
      'r2.internal',
      mockCtx.containerProxyFetcher
    );
    expect(deleteAdditionalHeaderFile).toHaveBeenCalledWith(
      '/tmp/.s3fs-ahbe-unmount.conf'
    );
  });

  it('deletes the password file when R2 egress mount fails', async () => {
    const mockCtx = createMockCtx();
    const sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
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
    const deleteAdditionalHeaderFile = vi.fn().mockResolvedValue(undefined);
    Object.assign(sandbox as object, {
      execInternal,
      createPasswordFile: vi.fn().mockResolvedValue(undefined),
      deletePasswordFile,
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile,
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-failed'),
      generateS3FSAdditionalHeaderFilePath: vi
        .fn()
        .mockReturnValue('/tmp/.s3fs-ahbe-failed.conf')
    });

    await expect(
      sandbox.mountBucket('MY_BUCKET', '/mnt/fail', {} as any)
    ).rejects.toThrow('S3FS mount failed');

    expect(deletePasswordFile).toHaveBeenCalledWith('/tmp/.s3fs-failed');
    expect(deleteAdditionalHeaderFile).toHaveBeenCalledWith(
      '/tmp/.s3fs-ahbe-failed.conf'
    );
    expect(mockCtx.exports.ContainerProxy).toHaveBeenLastCalledWith({
      props: {
        enableInternet: undefined,
        containerId: 'test-sandbox-id',
        className: 'ContainerProxy',
        outboundByHostOverrides: {
          'r2.internal': {
            method: 'r2EgressMount',
            params: { buckets: {} }
          }
        }
      }
    });
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
      createDisableExpectHeaderFile: vi.fn().mockResolvedValue(undefined),
      deleteAdditionalHeaderFile: vi.fn().mockResolvedValue(undefined),
      generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-check-fail')
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
        generatePasswordFilePath: vi.fn().mockReturnValue('/tmp/.s3fs-unused')
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
