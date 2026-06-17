import { DISABLE_SESSION_TOKEN } from '@repo/shared/internal';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../src/errors';
import { getSandbox } from '../src/sandbox';

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

    await expect(sandbox.exec('echo ready')).rejects.toMatchObject({
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

    it('routes implicit startProcess through the sessionless token when default sessions are disabled', async () => {
      mockStub.startProcess = vi.fn().mockResolvedValue({
        success: true,
        processId: 'proc-sessionless',
        command: 'sleep 10',
        timestamp: new Date().toISOString()
      });

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
        enableDefaultSession: false
      });

      await sandbox.startProcess('sleep 10', {
        env: { TEST_ENV: '1' },
        cwd: '/workspace/app',
        timeout: 1000
      });

      expect(mockStub.startProcess).toHaveBeenCalledWith('sleep 10', {
        env: { TEST_ENV: '1' },
        cwd: '/workspace/app',
        timeout: 1000,
        sessionId: DISABLE_SESSION_TOKEN
      });
    });

    it('routes implicit process reads through the sessionless token when default sessions are disabled', async () => {
      mockStub.listProcesses = vi.fn().mockResolvedValue([]);
      mockStub.getProcess = vi.fn().mockResolvedValue(null);

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
        enableDefaultSession: false
      });

      await sandbox.listProcesses();
      await sandbox.getProcess('proc-sessionless');

      expect(mockStub.listProcesses).toHaveBeenCalledWith(
        DISABLE_SESSION_TOKEN
      );
      expect(mockStub.getProcess).toHaveBeenCalledWith(
        'proc-sessionless',
        DISABLE_SESSION_TOKEN
      );
    });

    it('preserves explicit sessionIds for process reads when default sessions are disabled', async () => {
      mockStub.listProcesses = vi.fn().mockResolvedValue([]);
      mockStub.getProcess = vi.fn().mockResolvedValue(null);

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
        enableDefaultSession: false
      });

      await sandbox.listProcesses('explicit-session');
      await sandbox.getProcess('proc-explicit', 'explicit-session');

      expect(mockStub.listProcesses).toHaveBeenCalledWith('explicit-session');
      expect(mockStub.getProcess).toHaveBeenCalledWith(
        'proc-explicit',
        'explicit-session'
      );
    });

    it('routes implicit watch through the sessionless token when default sessions are disabled', async () => {
      mockStub.watch = vi.fn().mockResolvedValue(new ReadableStream());

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
        enableDefaultSession: false
      });

      await sandbox.watch('/workspace');

      expect(mockStub.watch).toHaveBeenCalledWith('/workspace', {
        sessionId: DISABLE_SESSION_TOKEN
      });
    });

    it('routes implicit checkChanges through the sessionless token when default sessions are disabled', async () => {
      mockStub.checkChanges = vi
        .fn()
        .mockResolvedValue({ status: 'unchanged', version: 1 });

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
        enableDefaultSession: false
      });

      await sandbox.checkChanges('/workspace');

      expect(mockStub.checkChanges).toHaveBeenCalledWith('/workspace', {
        sessionId: DISABLE_SESSION_TOKEN
      });
    });

    it('passes an explicit sessionId through watch even when default sessions are disabled', async () => {
      mockStub.watch = vi.fn().mockResolvedValue(new ReadableStream());

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox', {
        enableDefaultSession: false
      });

      await sandbox.watch('/workspace', { sessionId: 'my-session' });

      expect(mockStub.watch).toHaveBeenCalledWith('/workspace', {
        sessionId: 'my-session'
      });
    });

    it('routes terminal handle connections with explicit terminal IDs', async () => {
      let proxiedRequest: Request | undefined;
      mockStub.fetch = vi.fn(async (request: Request) => {
        proxiedRequest = request;
        return new Response(null, { status: 200 });
      });

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');
      const request = new Request('https://example.com/terminal', {
        headers: { Upgrade: 'websocket' }
      });

      const terminal = sandbox.terminal({ id: 'terminal-a' });
      await terminal.connect(request);

      expect(terminal.id).toBe('terminal-a');
      expect(mockStub.fetch).toHaveBeenCalledOnce();
      const url = new URL(proxiedRequest?.url ?? 'http://missing');
      expect(url.pathname).toBe('/proxy/3000/ws/terminal');
      expect(url.searchParams.get('terminalId')).toBe('terminal-a');
    });

    it('generates terminal IDs instead of using default session IDs', async () => {
      let proxiedRequest: Request | undefined;
      mockStub.fetch = vi.fn(async (request: Request) => {
        proxiedRequest = request;
        return new Response(null, { status: 200 });
      });

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');
      const request = new Request('https://example.com/terminal', {
        headers: { Upgrade: 'websocket' }
      });

      const terminal = sandbox.terminal();
      await terminal.connect(request);

      expect(terminal.id).toMatch(/^terminal-[0-9a-f-]{36}$/);
      expect(mockStub.fetch).toHaveBeenCalledOnce();
      const url = new URL(proxiedRequest?.url ?? 'http://missing');
      expect(url.searchParams.get('terminalId')).toBe(terminal.id);
      expect(url.searchParams.get('terminalId')).not.toBe(
        'sandbox-test-sandbox'
      );
    });

    it('destroys terminal handles by ID', async () => {
      let destroyRequest: Request | undefined;
      mockStub.fetch = vi.fn(async (request: Request) => {
        destroyRequest = request;
        return new Response(null, { status: 204 });
      });

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      await sandbox.terminal({ id: 'terminal-a' }).destroy();

      expect(mockStub.fetch).toHaveBeenCalledOnce();
      expect(destroyRequest?.method).toBe('DELETE');
      const url = new URL(destroyRequest?.url ?? 'http://missing');
      expect(url.pathname).toBe('/proxy/3000/terminals/terminal-a');
    });

    it('does not attach terminal helpers to command sessions', async () => {
      mockStub.createSession = vi.fn().mockResolvedValue({ id: 'session-a' });

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      const session = await sandbox.createSession({ id: 'session-a' });

      expect('terminal' in session).toBe(false);
    });

    it('should read properties directly from the stub', () => {
      mockStub.sleepAfter = '30m';

      const mockNamespace = {} as any;
      const sandbox = getSandbox(mockNamespace, 'test-sandbox');

      expect(sandbox.sleepAfter).toBe('30m');
    });
  });
});
