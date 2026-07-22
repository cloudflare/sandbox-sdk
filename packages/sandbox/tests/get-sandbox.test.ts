import { RpcTarget } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../src/errors';
import { getSandbox, type Sandbox } from '../src/sandbox';

// Mock the Container module
vi.mock('@cloudflare/containers', () => ({
  switchPort: vi.fn((request: Request, port: number) => {
    const headers = new Headers(request.headers);
    headers.set('cf-container-target-port', String(port));
    return new Request(request, { headers });
  }),
  Container: class Container {
    ctx: any;
    env: any;
    sleepAfter: string | number = '10m';
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  ContainerProxy: class ContainerProxy {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
      return new Response('Mock ContainerProxy fetch');
    }
  },
  getContainer: vi.fn()
}));

describe('getSandbox', () => {
  let mockStub: any;
  let mockGetContainer: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create a fresh mock stub for each test
    mockStub = {
      sleepAfter: '10m',
      configure: vi.fn(
        (configuration: {
          sandboxName?: { name: string; normalizeId?: boolean };
          sleepAfter?: string | number;
        }) => {
          if (configuration.sleepAfter !== undefined) {
            mockStub.sleepAfter = configuration.sleepAfter;
          }
          return Promise.resolve();
        }
      ),
      containerFetch: vi.fn(async () => new Response('container response')),
      authorizePortRequest: vi.fn(async () => 'route-token'),
      setSandboxName: vi.fn(),
      setSleepAfter: vi.fn((value: string | number) => {
        mockStub.sleepAfter = value;
      }),
      setKeepAlive: vi.fn()
    };

    // Mock getContainer to return our stub
    const containers = await import('@cloudflare/containers');
    mockGetContainer = vi.mocked(containers.getContainer);
    mockGetContainer.mockReturnValue(mockStub);
  });

  it('should create a sandbox instance with default sleepAfter', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox');

    expect(sandbox).toBeDefined();
    expect(mockStub.configure).toHaveBeenCalledWith({
      sandboxName: {
        name: 'test-sandbox',
        normalizeId: undefined
      }
    });
  });

  it('exposes containerFetch but not internal port authorization', async () => {
    const sandbox = getSandbox({} as any, 'test-sandbox');
    const internal = sandbox as unknown as Record<string, unknown>;

    expect(internal.containerFetch).toBeTypeOf('function');
    expect(internal.authorizePortRequest).toBeUndefined();

    const request = new Request('https://example.com/data');
    await sandbox.containerFetch(request, 8080);
    await sandbox.containerFetch(
      'https://example.com/data',
      { method: 'POST' },
      8081
    );

    expect(mockStub.containerFetch).toHaveBeenNthCalledWith(1, request, 8080);
    expect(mockStub.containerFetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/data',
      { method: 'POST' },
      8081
    );
  });

  it('authorizes switchPort requests across the Sandbox RPC boundary', async () => {
    mockStub.fetch = vi.fn(async () => new Response('forwarded'));
    const sandbox = getSandbox({} as any, 'test-sandbox');
    const request = new Request('https://example.com/ws', {
      headers: { 'cf-container-target-port': '8080' }
    });

    await sandbox.fetch(request);

    expect(mockStub.authorizePortRequest).toHaveBeenCalledWith(8080, '/ws');
    const forwarded = mockStub.fetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('cf-container-target-port')).toBe('8080');
    expect(forwarded.headers.get('x-sandbox-port-route-token')).toBe(
      'route-token'
    );
  });

  it('preserves switchPort routing to the inherited default port', async () => {
    mockStub.fetch = vi.fn(async () => new Response('forwarded'));
    const sandbox = getSandbox({} as any, 'test-sandbox');
    const request = new Request('https://example.com/app', {
      headers: { 'cf-container-target-port': '3000' }
    });

    await sandbox.fetch(request);

    expect(mockStub.authorizePortRequest).toHaveBeenCalledWith(3000, '/app');
  });

  it('does not expose token creation internals', () => {
    const sandbox = getSandbox({} as any, 'test-sandbox');
    const internal = sandbox as unknown as Record<string, unknown>;

    expect(internal.createPortRequestToken).toBeUndefined();
  });

  it('forwards native watch streams', async () => {
    const bytes = new TextEncoder().encode('data: watching\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    mockStub.watch = vi.fn().mockResolvedValue(stream);

    const sandbox = getSandbox({} as any, 'watch-sandbox');
    const result = await sandbox.watch('/workspace');
    const reader = result.getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: bytes });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined
    });
    expect(mockStub.watch).toHaveBeenCalledWith('/workspace', {});
  });

  it('applies configuration before forwarding operations', async () => {
    let resolveConfiguration!: () => void;
    mockStub.configure = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfiguration = resolve;
        })
    );
    mockStub.writeFile = vi.fn(async () => {});

    const sandbox = getSandbox({} as any, 'configured-sandbox', {
      keepAlive: true
    });
    const write = sandbox.writeFile('/workspace/file.txt', 'content');

    expect(mockStub.writeFile).not.toHaveBeenCalled();
    resolveConfiguration();
    await write;
    expect(mockStub.writeFile).toHaveBeenCalledOnce();
  });

  it('does not forward operations when configuration fails', async () => {
    mockStub.configure = vi.fn().mockRejectedValue(new Error('config failed'));
    mockStub.writeFile = vi.fn(async () => {});

    const sandbox = getSandbox({} as any, 'configured-sandbox', {
      keepAlive: true
    });

    await expect(
      sandbox.writeFile('/workspace/file.txt', 'content')
    ).rejects.toThrow('config failed');
    expect(mockStub.writeFile).not.toHaveBeenCalled();
  });

  it('shares pending configuration failures across clients', async () => {
    let rejectConfiguration!: (error: Error) => void;
    mockStub.configure = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectConfiguration = reject;
        })
    );
    mockStub.writeFile = vi.fn(async () => {});
    const mockNamespace = {} as any;

    const first = getSandbox(mockNamespace, 'configured-sandbox', {
      keepAlive: true
    });
    const second = getSandbox(mockNamespace, 'configured-sandbox', {
      keepAlive: true
    });
    const firstWrite = first.writeFile('/workspace/first.txt', 'first');
    const secondWrite = second.writeFile('/workspace/second.txt', 'second');

    expect(mockStub.configure).toHaveBeenCalledOnce();
    expect(mockStub.writeFile).not.toHaveBeenCalled();
    const rejectedWrites = Promise.all([
      expect(firstWrite).rejects.toThrow('config failed'),
      expect(secondWrite).rejects.toThrow('config failed')
    ]);
    rejectConfiguration(new Error('config failed'));
    await rejectedWrites;
    expect(mockStub.writeFile).not.toHaveBeenCalled();
  });

  it('maps Durable Object code-update resets to OperationInterruptedError for enhanced methods', async () => {
    const mockNamespace = {} as any;
    mockStub.exec = vi.fn(async () => {
      throw new Error('Durable Object reset because its code was updated.');
    });
    const sandbox = getSandbox(mockNamespace, 'test-sandbox');

    await expect(sandbox.exec(['echo', 'ready'])).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: {
        reason: 'runtime_replaced',
        operation: 'sandbox.exec',
        phase: 'durable_object_call',
        admitted: 'unknown',
        retryable: false
      }
    });
  });

  it('should apply sleepAfter option when provided as string', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      sleepAfter: '5m'
    });

    expect(sandbox.sleepAfter).toBe('5m');
  });

  it('should apply sleepAfter option when provided as number', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      sleepAfter: 300 // 5 minutes in seconds
    });

    expect(sandbox.sleepAfter).toBe(300);
  });

  it('should not apply sleepAfter when not provided', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox');

    // Should remain default value from Container
    expect(sandbox.sleepAfter).toBe('10m');
  });

  it('should accept various time string formats for sleepAfter', () => {
    const mockNamespace = {} as any;
    const testCases = ['30s', '1m', '10m', '1h', '2h'];

    for (const timeString of testCases) {
      // Reset the mock stub for each iteration
      mockStub.sleepAfter = '3m';

      const sandbox = getSandbox(mockNamespace, `test-sandbox-${timeString}`, {
        sleepAfter: timeString
      });

      expect(sandbox.sleepAfter).toBe(timeString);
    }
  });

  it('should apply keepAlive option when provided as true', () => {
    const mockNamespace = {} as any;
    getSandbox(mockNamespace, 'test-sandbox', {
      keepAlive: true
    });

    expect(mockStub.configure).toHaveBeenCalledWith({
      sandboxName: {
        name: 'test-sandbox',
        normalizeId: undefined
      },
      keepAlive: true
    });
  });

  it('should apply keepAlive option when provided as false', () => {
    const mockNamespace = {} as any;
    getSandbox(mockNamespace, 'test-sandbox', {
      keepAlive: false
    });

    expect(mockStub.configure).toHaveBeenCalledWith({
      sandboxName: {
        name: 'test-sandbox',
        normalizeId: undefined
      },
      keepAlive: false
    });
  });

  it('should not include keepAlive when option is not provided', () => {
    const mockNamespace = {} as any;
    getSandbox(mockNamespace, 'test-sandbox');

    expect(mockStub.configure).toHaveBeenCalledWith({
      sandboxName: {
        name: 'test-sandbox',
        normalizeId: undefined
      }
    });
  });

  it('should apply keepAlive alongside other options', () => {
    const mockNamespace = {} as any;
    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      sleepAfter: '5m',
      keepAlive: true
    });

    expect(sandbox.sleepAfter).toBe('5m');
    expect(mockStub.configure).toHaveBeenCalledWith({
      sandboxName: {
        name: 'test-sandbox',
        normalizeId: undefined
      },
      sleepAfter: '5m',
      keepAlive: true
    });
  });

  it('should preserve sandbox ID case by default', () => {
    const mockNamespace = {} as any;
    getSandbox(mockNamespace, 'MyProject-ABC123');

    expect(mockGetContainer).toHaveBeenCalledWith(
      mockNamespace,
      'MyProject-ABC123'
    );
  });

  it('should normalize sandbox ID to lowercase when normalizeId option is true', () => {
    const mockNamespace = {} as any;
    getSandbox(mockNamespace, 'MyProject-ABC123', { normalizeId: true });

    expect(mockGetContainer).toHaveBeenCalledWith(
      mockNamespace,
      'myproject-abc123'
    );
  });

  it('should skip repeated configuration for the same sandbox in one isolate', async () => {
    const mockNamespace = {} as any;

    getSandbox(mockNamespace, 'test-sandbox', { sleepAfter: '5m' });
    await Promise.resolve();

    getSandbox(mockNamespace, 'test-sandbox', { sleepAfter: '5m' });

    expect(mockStub.configure).toHaveBeenCalledTimes(1);
  });

  it('should only configure fields that changed on later calls', async () => {
    const mockNamespace = {} as any;
    mockStub.listProcesses = vi.fn(async () => []);

    getSandbox(mockNamespace, 'test-sandbox');
    await Promise.resolve();

    const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
      sleepAfter: '5m'
    });
    await sandbox.listProcesses();

    expect(mockStub.configure).toHaveBeenNthCalledWith(1, {
      sandboxName: {
        name: 'test-sandbox',
        normalizeId: undefined
      }
    });
    expect(mockStub.configure).toHaveBeenNthCalledWith(2, {
      sleepAfter: '5m'
    });
  });

  it('should only configure the sandbox name by default', () => {
    const mockNamespace = {} as any;
    getSandbox(mockNamespace, 'test-sandbox');

    expect(mockStub.configure).toHaveBeenCalledWith({
      sandboxName: {
        name: 'test-sandbox',
        normalizeId: undefined
      }
    });
  });

  describe('proxy method routing', () => {
    it('should preserve this binding for fetch()', async () => {
      // fetch() is a native DurableObjectStub method that requires correct
      // this binding. Without explicit handling in enhancedMethods, the
      // Proxy's get trap returns an unbound function reference.
      const expectedResponse = new Response('ok');
      mockStub.fetch = function (this: any, _req: Request) {
        if (this !== mockStub) {
          throw new Error(
            'this binding lost — fetch called with wrong receiver'
          );
        }
        return Promise.resolve(expectedResponse);
      };

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      const response = await sandbox.fetch(new Request('http://localhost/'));
      expect(response).toBe(expectedResponse);
    });

    it('should pass through non-enhanced methods to the stub', async () => {
      // RPC methods like exec, writeFile, etc. are accessed via target[prop]
      // and dispatched through JSRPC which doesn't need this binding.
      mockStub.validatePortToken = vi.fn().mockResolvedValue(true);

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      await sandbox.validatePortToken(8080, 'token123');
      expect(mockStub.validatePortToken).toHaveBeenCalledWith(8080, 'token123');
    });

    it('creates caller-local process handles and sanitizes exec options', async () => {
      const capability = {
        status: vi.fn(),
        openLogs: vi.fn(),
        openPortWatch: vi.fn(),
        kill: vi.fn()
      };
      mockStub.exec = vi.fn().mockResolvedValue({
        id: 'p1',
        pid: 123,
        capability
      });
      const mockNamespace = {} as unknown as DurableObjectNamespace<Sandbox>;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');
      const options = {
        env: { TEST_ENV: '1' },
        cwd: '/workspace/app',
        timeout: 1000,
        signal: new AbortController().signal,
        callback: () => 'not serializable',
        unrelated: true
      };

      const process = await sandbox.exec(['echo', 'test'], options);

      expect(process).not.toBeInstanceOf(RpcTarget);
      expect(process).toMatchObject({ id: 'p1', pid: 123 });
      expect(mockStub.exec).toHaveBeenCalledWith(['echo', 'test'], {
        env: { TEST_ENV: '1' },
        cwd: '/workspace/app',
        timeout: 1000
      });
    });

    it('converts recovered descriptors and returns process listings as data', async () => {
      const capability = {
        status: vi.fn(),
        openLogs: vi.fn(),
        openPortWatch: vi.fn(),
        kill: vi.fn()
      };
      const status = {
        id: 'p1',
        pid: 123,
        command: ['/bin/true'],
        state: 'running',
        startedAt: new Date().toISOString()
      };
      mockStub.getProcess = vi
        .fn()
        .mockResolvedValueOnce({ id: 'p1', pid: 123, capability })
        .mockResolvedValueOnce(null);
      mockStub.listProcesses = vi.fn().mockResolvedValue([status]);
      const mockNamespace = {} as unknown as DurableObjectNamespace<Sandbox>;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      await expect(sandbox.getProcess('p1')).resolves.toMatchObject({
        id: 'p1',
        pid: 123
      });
      await expect(sandbox.getProcess('missing')).resolves.toBeNull();
      await expect(sandbox.listProcesses()).resolves.toEqual([status]);
      expect(capability.status).not.toHaveBeenCalled();
    });

    it('routes file operations through file RPC methods', async () => {
      mockStub.writeFile = vi.fn().mockResolvedValue({});
      mockStub.readFile = vi.fn().mockResolvedValue({});
      mockStub.readFileStream = vi.fn().mockResolvedValue(new ReadableStream());
      mockStub.mkdir = vi.fn().mockResolvedValue({});
      mockStub.deleteFile = vi.fn().mockResolvedValue({});
      mockStub.renameFile = vi.fn().mockResolvedValue({});
      mockStub.moveFile = vi.fn().mockResolvedValue({});
      mockStub.listFiles = vi.fn().mockResolvedValue({ files: [] });
      mockStub.exists = vi.fn().mockResolvedValue({ exists: true });

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      await sandbox.writeFile('/workspace/file.txt', 'content', {
        encoding: 'utf8'
      });
      await sandbox.readFile('/workspace/file.txt', { encoding: 'utf8' });
      await sandbox.readFileStream('/workspace/file.txt');
      await sandbox.mkdir('/workspace/dir', { recursive: true });
      await sandbox.deleteFile('/workspace/file.txt');
      await sandbox.renameFile('/workspace/old.txt', '/workspace/new.txt');
      await sandbox.moveFile('/workspace/src.txt', '/workspace/dest.txt');
      await sandbox.listFiles('/workspace', { includeHidden: true });
      await sandbox.exists('/workspace/file.txt');

      expect(mockStub.writeFile).toHaveBeenCalledWith(
        '/workspace/file.txt',
        'content',
        { encoding: 'utf8' }
      );
      expect(mockStub.readFile).toHaveBeenCalledWith('/workspace/file.txt', {
        encoding: 'utf8'
      });
      expect(mockStub.readFileStream).toHaveBeenCalledWith(
        '/workspace/file.txt'
      );
      expect(mockStub.mkdir).toHaveBeenCalledWith('/workspace/dir', {
        recursive: true
      });
      expect(mockStub.deleteFile).toHaveBeenCalledWith('/workspace/file.txt');
      expect(mockStub.renameFile).toHaveBeenCalledWith(
        '/workspace/old.txt',
        '/workspace/new.txt'
      );
      expect(mockStub.moveFile).toHaveBeenCalledWith(
        '/workspace/src.txt',
        '/workspace/dest.txt'
      );
      expect(mockStub.listFiles).toHaveBeenCalledWith('/workspace', {
        includeHidden: true
      });
      expect(mockStub.exists).toHaveBeenCalledWith('/workspace/file.txt');
    });

    it('routes terminal handle connections with generated terminal IDs', async () => {
      let proxiedRequest: Request | undefined;
      mockStub.fetch = vi.fn(async (request: Request) => {
        proxiedRequest = request;
        return new Response(null, { status: 200 });
      });
      mockStub.createTerminal = vi.fn(async () => ({
        snapshot: {
          id: 'terminal-a',
          command: ['bash'],
          status: 'running'
        },
        runtimeIncarnationID: 'runtime-a',
        capability: {
          authorizeConnection: vi.fn(async () => 'terminal-route-token')
        }
      }));

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');
      const request = new Request('https://example.com/terminal', {
        headers: { Upgrade: 'websocket' }
      });

      const terminal = await sandbox.createTerminal({ command: ['bash'] });
      await terminal.connect(request);

      expect(terminal.id).toBe('terminal-a');
      expect(mockStub.createTerminal).toHaveBeenCalledWith({
        command: ['bash']
      });
      expect(mockStub.fetch).toHaveBeenCalledOnce();
      const proxiedURL = new URL(proxiedRequest!.url);
      expect(proxiedURL.pathname).toBe('/ws/terminal');
      expect(proxiedRequest?.headers.get('cf-container-target-port')).toBe(
        '3000'
      );
      expect(proxiedURL.searchParams.get('terminalId')).toBe('terminal-a');
      expect(proxiedURL.searchParams.get('runtimeIncarnationID')).toBe(
        'runtime-a'
      );
    });

    it('reconstructs terminal output from a pull subscription', async () => {
      const event = {
        type: 'data' as const,
        terminalId: 'terminal-a',
        cursor: '1',
        timestamp: new Date().toISOString(),
        data: new Uint8Array([65])
      };
      const next = vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: event })
        .mockResolvedValueOnce({ done: true, value: undefined });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const dispose = vi.fn();
      mockStub.createTerminal = vi.fn(async () => ({
        snapshot: {
          id: 'terminal-a',
          command: ['bash'],
          status: 'running'
        },
        runtimeIncarnationID: 'runtime-a',
        capability: {
          openOutput: vi.fn(async () => ({
            next,
            cancel,
            [Symbol.dispose]: dispose
          }))
        }
      }));

      const sandbox = getSandbox({} as any, 'test-sandbox');
      const terminal = await sandbox.createTerminal({ command: ['bash'] });
      const reader = (await terminal.output()).getReader();

      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: event
      });
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined
      });
      expect(next).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(Object.keys(terminal)).toEqual([
        'id',
        'getSnapshot',
        'write',
        'resize',
        'output',
        'waitForExit',
        'interrupt',
        'terminate',
        'connect'
      ]);
      expect('openOutput' in terminal).toBe(false);
      expect('runtimeIncarnationID' in terminal).toBe(false);
    });

    it('gets and lists terminal handles by snapshot', async () => {
      mockStub.getTerminal = vi.fn(async () => ({
        snapshot: {
          id: 'terminal-a',
          command: ['bash'],
          status: 'running'
        },
        runtimeIncarnationID: 'runtime-a',
        capability: {}
      }));
      mockStub.listTerminals = vi.fn(async () => [
        {
          snapshot: {
            id: 'terminal-a',
            command: ['bash'],
            status: 'running'
          },
          runtimeIncarnationID: 'runtime-a',
          capability: {}
        }
      ]);

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      await expect(sandbox.getTerminal('terminal-a')).resolves.toMatchObject({
        id: 'terminal-a'
      });
      await expect(sandbox.listTerminals()).resolves.toHaveLength(1);

      expect(mockStub.getTerminal).toHaveBeenCalledWith('terminal-a');
      expect(mockStub.listTerminals).toHaveBeenCalledOnce();
    });

    it('forwards terminal interrupt and terminate through handle methods', async () => {
      mockStub.getTerminal = vi.fn(async () => ({
        snapshot: {
          id: 'terminal-a',
          command: ['bash'],
          status: 'running'
        },
        runtimeIncarnationID: 'runtime-a',
        capability: {
          interrupt: vi.fn(),
          terminate: vi.fn()
        }
      }));

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');
      const terminal = await sandbox.getTerminal('terminal-a');

      await terminal?.interrupt();
      await terminal?.terminate();

      expect(mockStub.getTerminal).toHaveBeenCalledWith('terminal-a');
    });

    it('should read properties directly from the stub', () => {
      mockStub.sleepAfter = '30m';

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      expect(sandbox.sleepAfter).toBe('30m');
    });
  });
});
