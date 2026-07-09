import { RpcTarget } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../src/errors';
import { getSandbox, type Sandbox } from '../src/sandbox';

// Mock the Container module
vi.mock('@cloudflare/containers', () => ({
  switchPort: vi.fn((request: Request, port: number) => {
    const url = new URL(request.url);
    url.pathname = `/proxy/${port}${url.pathname}`;
    return new Request(url, request);
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

    getSandbox(mockNamespace, 'test-sandbox');
    await Promise.resolve();

    getSandbox(mockNamespace, 'test-sandbox', { sleepAfter: '5m' });

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

    it('should pass through non-enhanced methods to the stub', () => {
      // RPC methods like exec, writeFile, etc. are accessed via target[prop]
      // and dispatched through JSRPC which doesn't need this binding.
      mockStub.validatePortToken = vi.fn().mockResolvedValue(true);

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      sandbox.validatePortToken(8080, 'token123');
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
        id: 'terminal-a',
        connect: (request: Request) => mockStub.fetch(request)
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
      expect(proxiedRequest?.url).toBe('https://example.com/terminal');
    });

    it('gets and lists terminal handles by snapshot', async () => {
      mockStub.getTerminal = vi.fn(async () => ({
        id: 'terminal-a',
        command: ['bash'],
        status: 'running'
      }));
      mockStub.listTerminals = vi.fn(async () => [
        { id: 'terminal-a', command: ['bash'], status: 'running' }
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
        id: 'terminal-a',
        command: ['bash'],
        status: 'running',
        interrupt: vi.fn(),
        terminate: vi.fn()
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
