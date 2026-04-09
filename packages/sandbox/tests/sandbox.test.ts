import { Container } from '@cloudflare/containers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, Sandbox } from '../src/sandbox';

// Mock dependencies before imports
vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const mockSwitchPort = vi.fn((request: Request, port: number) => {
    // Create a new request with the port in the URL path
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
      // Mock implementation - will be spied on in tests
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        return new Response('WebSocket Upgraded', {
          status: 200,
          headers: {
            'X-WebSocket-Upgraded': 'true',
            Upgrade: 'websocket',
            Connection: 'Upgrade'
          }
        });
      }
      return new Response('Mock Container fetch');
    }
    async containerFetch(request: Request, port: number): Promise<Response> {
      // Mock implementation for HTTP path
      return new Response('Mock Container HTTP fetch');
    }
    async getState() {
      // Mock implementation - return healthy state
      return { status: 'healthy' };
    }
    renewActivityTimeout() {
      // Mock implementation - reschedules activity timeout
    }
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: mockSwitchPort
  };
});

interface MockStorage {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

interface MockCtx {
  storage: MockStorage;
  blockConcurrencyWhile: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  id: {
    toString: () => string;
    equals: ReturnType<typeof vi.fn>;
    name: string;
  };
}

describe('Sandbox - Automatic Session Management', () => {
  let sandbox: Sandbox;
  let mockCtx: MockCtx;
  let mockEnv: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock DurableObjectState
    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map())
      } as any,
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

    mockEnv = {};

    // Create Sandbox instance - SandboxClient is created internally
    const stub = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      mockEnv
    );

    // Wait for blockConcurrencyWhile to complete
    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    sandbox = Object.assign(stub, {
      wsConnect: connect(stub)
    });

    // Now spy on the client methods that we need for testing
    vi.spyOn(sandbox.client.utils, 'createSession').mockResolvedValue({
      success: true,
      id: 'sandbox-default',
      message: 'Created'
    } as any);

    vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      command: '',
      timestamp: new Date().toISOString()
    } as any);

    vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
      success: true,
      path: '/test.txt',
      timestamp: new Date().toISOString()
    } as any);

    vi.spyOn(sandbox.client.watch, 'checkChanges').mockResolvedValue({
      success: true,
      status: 'unchanged',
      version: 'watch-1:0',
      timestamp: new Date().toISOString()
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('default session management', () => {
    it('should create default session on first operation', async () => {
      vi.mocked(sandbox.client.commands.execute).mockResolvedValueOnce({
        success: true,
        stdout: 'test output',
        stderr: '',
        exitCode: 0,
        command: 'echo test',
        timestamp: new Date().toISOString()
      } as any);

      await sandbox.exec('echo test');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);
      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringMatching(/^sandbox-/),
          cwd: '/workspace'
        })
      );

      expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
        'echo test',
        expect.stringMatching(/^sandbox-/),
        undefined
      );
    });

    it('should forward exec options to the command client', async () => {
      await sandbox.exec('echo $OPTION', {
        env: { OPTION: 'value' },
        cwd: '/workspace/project',
        timeout: 5000
      });

      expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
        'echo $OPTION',
        expect.stringMatching(/^sandbox-/),
        {
          timeoutMs: 5000,
          env: { OPTION: 'value' },
          cwd: '/workspace/project'
        }
      );
    });

    it('should forward checkChanges options to the watch client', async () => {
      await sandbox.checkChanges('/workspace/test', {
        since: 'watch-1:0',
        recursive: false
      });

      expect(sandbox.client.watch.checkChanges).toHaveBeenCalledWith({
        path: '/workspace/test',
        recursive: false,
        include: undefined,
        exclude: undefined,
        since: 'watch-1:0',
        sessionId: expect.stringMatching(/^sandbox-/)
      });
    });

    it('should reuse default session across multiple operations', async () => {
      await sandbox.exec('echo test1');
      await sandbox.writeFile('/test.txt', 'content');
      await sandbox.exec('echo test2');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);

      const firstSessionId = vi.mocked(sandbox.client.commands.execute).mock
        .calls[0][1];
      const fileSessionId = vi.mocked(sandbox.client.files.writeFile).mock
        .calls[0][2];
      const secondSessionId = vi.mocked(sandbox.client.commands.execute).mock
        .calls[1][1];

      expect(firstSessionId).toBe(fileSessionId);
      expect(firstSessionId).toBe(secondSessionId);
    });

    it('should use default session for process management', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-1',
        pid: 1234,
        command: 'sleep 10',
        timestamp: new Date().toISOString()
      } as any);

      vi.spyOn(sandbox.client.processes, 'listProcesses').mockResolvedValue({
        success: true,
        processes: [
          {
            id: 'proc-1',
            pid: 1234,
            command: 'sleep 10',
            status: 'running',
            startTime: new Date().toISOString()
          }
        ],
        timestamp: new Date().toISOString()
      } as any);

      const process = await sandbox.startProcess('sleep 10');
      const processes = await sandbox.listProcesses();

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);

      // startProcess uses sessionId (to start process in that session)
      const startSessionId = vi.mocked(sandbox.client.processes.startProcess)
        .mock.calls[0][1];
      expect(startSessionId).toMatch(/^sandbox-/);

      // listProcesses is sandbox-scoped - no sessionId parameter
      const listProcessesCall = vi.mocked(
        sandbox.client.processes.listProcesses
      ).mock.calls[0];
      expect(listProcessesCall).toEqual([]);

      // Verify the started process appears in the list
      expect(process.id).toBe('proc-1');
      expect(processes).toHaveLength(1);
      expect(processes[0].id).toBe('proc-1');
    });

    it('should use default session for git operations', async () => {
      vi.spyOn(sandbox.client.git, 'checkout').mockResolvedValue({
        success: true,
        stdout: 'Cloned successfully',
        stderr: '',
        branch: 'main',
        targetDir: '/workspace/repo',
        timestamp: new Date().toISOString()
      } as any);

      await sandbox.gitCheckout('https://github.com/test/repo.git', {
        branch: 'main'
      });

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);
      expect(sandbox.client.git.checkout).toHaveBeenCalledWith(
        'https://github.com/test/repo.git',
        expect.stringMatching(/^sandbox-/),
        { branch: 'main', targetDir: undefined }
      );
    });

    it('should initialize session with sandbox name when available', async () => {
      await sandbox.setSandboxName('my-sandbox');

      await sandbox.exec('pwd');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sandbox-my-sandbox',
          cwd: '/workspace'
        })
      );
    });
  });

  describe('explicit session creation', () => {
    it('should create isolated execution session', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'custom-session-123',
        message: 'Created'
      } as any);

      const session = await sandbox.createSession({
        id: 'custom-session-123',
        env: { NODE_ENV: 'test' },
        cwd: '/test'
      });

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: 'custom-session-123',
        env: { NODE_ENV: 'test' },
        cwd: '/test'
      });

      expect(session.id).toBe('custom-session-123');
      expect(session.exec).toBeInstanceOf(Function);
      expect(session.startProcess).toBeInstanceOf(Function);
      expect(session.writeFile).toBeInstanceOf(Function);
      expect(session.gitCheckout).toBeInstanceOf(Function);
    });

    it('should execute operations in specific session context', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'isolated-session',
        message: 'Created'
      } as any);

      const session = await sandbox.createSession({ id: 'isolated-session' });

      await session.exec('echo test');

      expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
        'echo test',
        'isolated-session',
        undefined
      );
    });

    it('should isolate multiple explicit sessions', async () => {
      vi.mocked(sandbox.client.utils.createSession)
        .mockResolvedValueOnce({
          success: true,
          id: 'session-1',
          message: 'Created'
        } as any)
        .mockResolvedValueOnce({
          success: true,
          id: 'session-2',
          message: 'Created'
        } as any);

      const session1 = await sandbox.createSession({ id: 'session-1' });
      const session2 = await sandbox.createSession({ id: 'session-2' });

      await session1.exec('echo build');
      await session2.exec('echo test');

      const session1Id = vi.mocked(sandbox.client.commands.execute).mock
        .calls[0][1];
      const session2Id = vi.mocked(sandbox.client.commands.execute).mock
        .calls[1][1];

      expect(session1Id).toBe('session-1');
      expect(session2Id).toBe('session-2');
      expect(session1Id).not.toBe(session2Id);
    });

    it('should not interfere with default session', async () => {
      vi.mocked(sandbox.client.utils.createSession)
        .mockResolvedValueOnce({
          success: true,
          id: 'sandbox-default',
          message: 'Created'
        } as any)
        .mockResolvedValueOnce({
          success: true,
          id: 'explicit-session',
          message: 'Created'
        } as any);

      await sandbox.exec('echo default');

      const explicitSession = await sandbox.createSession({
        id: 'explicit-session'
      });
      await explicitSession.exec('echo explicit');

      await sandbox.exec('echo default-again');

      const defaultSessionId1 = vi.mocked(sandbox.client.commands.execute).mock
        .calls[0][1];
      const explicitSessionId = vi.mocked(sandbox.client.commands.execute).mock
        .calls[1][1];
      const defaultSessionId2 = vi.mocked(sandbox.client.commands.execute).mock
        .calls[2][1];

      expect(defaultSessionId1).toBe('sandbox-default');
      expect(explicitSessionId).toBe('explicit-session');
      expect(defaultSessionId2).toBe('sandbox-default');
      expect(defaultSessionId1).toBe(defaultSessionId2);
      expect(explicitSessionId).not.toBe(defaultSessionId1);
    });

    it('should generate session ID if not provided', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'session-generated-123',
        message: 'Created'
      } as any);

      await sandbox.createSession();

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringMatching(/^session-/)
        })
      );
    });
  });

  describe('ExecutionSession operations', () => {
    let session: any;

    beforeEach(async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'test-session',
        message: 'Created'
      } as any);

      session = await sandbox.createSession({ id: 'test-session' });
    });

    it('should execute command with session context', async () => {
      await session.exec('pwd');
      expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
        'pwd',
        'test-session',
        undefined
      );
    });

    it('should start process with session context', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-1',
          pid: 1234,
          command: 'sleep 10',
          status: 'running',
          startTime: new Date().toISOString()
        }
      } as any);

      await session.startProcess('sleep 10');

      expect(sandbox.client.processes.startProcess).toHaveBeenCalledWith(
        'sleep 10',
        'test-session',
        {}
      );
    });

    it('should write file with session context', async () => {
      vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
        success: true,
        path: '/test.txt',
        timestamp: new Date().toISOString()
      } as any);

      await session.writeFile('/test.txt', 'content');

      expect(sandbox.client.files.writeFile).toHaveBeenCalledWith(
        '/test.txt',
        'content',
        'test-session',
        { encoding: undefined }
      );
    });

    it('should perform git checkout with session context', async () => {
      vi.spyOn(sandbox.client.git, 'checkout').mockResolvedValue({
        success: true,
        stdout: 'Cloned',
        stderr: '',
        branch: 'main',
        targetDir: '/workspace/repo',
        timestamp: new Date().toISOString()
      } as any);

      await session.gitCheckout('https://github.com/test/repo.git');

      expect(sandbox.client.git.checkout).toHaveBeenCalledWith(
        'https://github.com/test/repo.git',
        'test-session',
        { branch: undefined, targetDir: undefined }
      );
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle session creation errors gracefully', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockRejectedValueOnce(
        new Error('Session creation failed')
      );

      await expect(sandbox.exec('echo test')).rejects.toThrow(
        'Session creation failed'
      );
    });

    it('should initialize with empty environment when not set', async () => {
      await sandbox.exec('pwd');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.any(String),
          cwd: '/workspace'
        })
      );
    });

    it('should use updated environment after setEnvVars', async () => {
      await sandbox.setEnvVars({ NODE_ENV: 'production', DEBUG: 'true' });

      await sandbox.exec('env');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: expect.any(String),
        env: { NODE_ENV: 'production', DEBUG: 'true' },
        cwd: '/workspace'
      });
    });
  });

  describe('port exposure - workers.dev detection', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox');
      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        name: 'test-service',
        exposedAt: new Date().toISOString()
      } as any);
    });

    it('should reject workers.dev domains with CustomDomainRequiredError', async () => {
      const hostnames = [
        'my-worker.workers.dev',
        'my-worker.my-account.workers.dev'
      ];

      for (const hostname of hostnames) {
        try {
          await sandbox.exposePort(8080, { name: 'test', hostname });
          // Should not reach here
          expect.fail('Should have thrown CustomDomainRequiredError');
        } catch (error: any) {
          expect(error.name).toBe('CustomDomainRequiredError');
          expect(error.code).toBe('CUSTOM_DOMAIN_REQUIRED');
          expect(error.message).toContain('workers.dev');
          expect(error.message).toContain('custom domain');
        }
      }

      // Verify client method was never called
      expect(sandbox.client.ports.exposePort).not.toHaveBeenCalled();
    });

    it('should accept custom domains and subdomains', async () => {
      const testCases = [
        { hostname: 'example.com', description: 'apex domain' },
        { hostname: 'sandbox.example.com', description: 'subdomain' }
      ];

      for (const { hostname } of testCases) {
        const result = await sandbox.exposePort(8080, {
          name: 'test',
          hostname
        });
        expect(result.url).toContain(hostname);
        expect(result.port).toBe(8080);
      }
    });

    it('should accept localhost for local development', async () => {
      const result = await sandbox.exposePort(8080, {
        name: 'test',
        hostname: 'localhost:8787'
      });

      expect(result.url).toContain('localhost');
      expect(sandbox.client.ports.exposePort).toHaveBeenCalled();
    });
  });

  describe('fetch() override - WebSocket detection', () => {
    let superFetchSpy: any;

    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox');

      // Spy on Container.prototype.fetch to verify WebSocket routing
      superFetchSpy = vi
        .spyOn(Container.prototype, 'fetch')
        .mockResolvedValue(new Response('WebSocket response'));
    });

    afterEach(() => {
      superFetchSpy?.mockRestore();
    });

    it('should detect WebSocket upgrade header and route to super.fetch', async () => {
      const request = new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        }
      });

      const response = await sandbox.fetch(request);

      // Should route through super.fetch() for WebSocket
      expect(superFetchSpy).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe('WebSocket response');
    });

    it('should route non-WebSocket requests through containerFetch', async () => {
      // GET request
      const getRequest = new Request('https://example.com/api/data');
      await sandbox.fetch(getRequest);
      expect(superFetchSpy).not.toHaveBeenCalled();

      vi.clearAllMocks();

      // POST request
      const postRequest = new Request('https://example.com/api/data', {
        method: 'POST',
        body: JSON.stringify({ data: 'test' }),
        headers: { 'Content-Type': 'application/json' }
      });
      await sandbox.fetch(postRequest);
      expect(superFetchSpy).not.toHaveBeenCalled();

      vi.clearAllMocks();

      // SSE request (should not be detected as WebSocket)
      const sseRequest = new Request('https://example.com/events', {
        headers: { Accept: 'text/event-stream' }
      });
      await sandbox.fetch(sseRequest);
      expect(superFetchSpy).not.toHaveBeenCalled();
    });

    it('should preserve WebSocket request unchanged when calling super.fetch()', async () => {
      const request = new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'test-key-123',
          'Sec-WebSocket-Version': '13'
        }
      });

      await sandbox.fetch(request);

      expect(superFetchSpy).toHaveBeenCalledTimes(1);
      const passedRequest = superFetchSpy.mock.calls[0][0] as Request;
      expect(passedRequest.headers.get('Upgrade')).toBe('websocket');
      expect(passedRequest.headers.get('Connection')).toBe('Upgrade');
      expect(passedRequest.headers.get('Sec-WebSocket-Key')).toBe(
        'test-key-123'
      );
      expect(passedRequest.headers.get('Sec-WebSocket-Version')).toBe('13');
    });
  });

  describe('wsConnect() method', () => {
    it('should route WebSocket request through switchPort to sandbox.fetch', async () => {
      const { switchPort } = await import('@cloudflare/containers');
      const switchPortMock = vi.mocked(switchPort);

      const request = new Request('http://localhost/ws/echo', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        }
      });

      const fetchSpy = vi.spyOn(sandbox, 'fetch');
      const response = await sandbox.wsConnect(request, 8080);

      // Verify switchPort was called with correct port
      expect(switchPortMock).toHaveBeenCalledWith(request, 8080);

      // Verify fetch was called with the switched request
      expect(fetchSpy).toHaveBeenCalledOnce();

      // Verify response indicates WebSocket upgrade
      expect(response.status).toBe(200);
      expect(response.headers.get('X-WebSocket-Upgraded')).toBe('true');
    });

    it('should reject invalid ports with SecurityError', async () => {
      const request = new Request('http://localhost/ws/test', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' }
      });

      // Invalid port values
      await expect(sandbox.wsConnect(request, -1)).rejects.toThrow(
        'Invalid port number'
      );
      await expect(sandbox.wsConnect(request, 0)).rejects.toThrow(
        'Invalid port number'
      );
      await expect(sandbox.wsConnect(request, 70000)).rejects.toThrow(
        'Invalid port number'
      );

      // Privileged ports
      await expect(sandbox.wsConnect(request, 80)).rejects.toThrow(
        'Invalid port number'
      );
      await expect(sandbox.wsConnect(request, 443)).rejects.toThrow(
        'Invalid port number'
      );
    });

    it('should preserve request properties through routing', async () => {
      const request = new Request(
        'http://localhost/ws/test?token=abc&room=lobby',
        {
          headers: {
            Upgrade: 'websocket',
            Connection: 'Upgrade',
            'X-Custom-Header': 'custom-value'
          }
        }
      );

      const fetchSpy = vi.spyOn(sandbox, 'fetch');
      await sandbox.wsConnect(request, 8080);

      const calledRequest = fetchSpy.mock.calls[0][0];

      // Verify headers are preserved
      expect(calledRequest.headers.get('Upgrade')).toBe('websocket');
      expect(calledRequest.headers.get('X-Custom-Header')).toBe('custom-value');

      // Verify query parameters are preserved
      const url = new URL(calledRequest.url);
      expect(url.searchParams.get('token')).toBe('abc');
      expect(url.searchParams.get('room')).toBe('lobby');
    });
  });

  describe('deleteSession', () => {
    it('should prevent deletion of default session', async () => {
      // Trigger creation of default session
      await sandbox.exec('echo "test"');

      // Verify default session exists
      expect((sandbox as any).defaultSession).toBeTruthy();
      const defaultSessionId = (sandbox as any).defaultSession;

      // Attempt to delete default session should throw
      await expect(sandbox.deleteSession(defaultSessionId)).rejects.toThrow(
        `Cannot delete default session '${defaultSessionId}'. Use sandbox.destroy() to terminate the sandbox.`
      );
    });

    it('should allow deletion of non-default sessions', async () => {
      // Mock the deleteSession API response
      vi.spyOn(sandbox.client.utils, 'deleteSession').mockResolvedValue({
        success: true,
        sessionId: 'custom-session',
        timestamp: new Date().toISOString()
      });

      // Create a custom session
      await sandbox.createSession({ id: 'custom-session' });

      // Should successfully delete non-default session
      const result = await sandbox.deleteSession('custom-session');
      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('custom-session');
    });
  });

  describe('constructPreviewUrl validation', () => {
    it('should throw clear error for ID with uppercase letters without normalizeId', async () => {
      await sandbox.setSandboxName('MyProject-123', false);

      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        url: '',
        timestamp: '2023-01-01T00:00:00Z'
      });

      await expect(
        sandbox.exposePort(8080, { hostname: 'example.com' })
      ).rejects.toThrow(/Preview URLs require lowercase sandbox IDs/);
    });

    it('should construct valid URL for lowercase ID', async () => {
      await sandbox.setSandboxName('my-project', false);

      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        url: '',
        timestamp: '2023-01-01T00:00:00Z'
      });

      const result = await sandbox.exposePort(8080, {
        hostname: 'example.com'
      });

      expect(result.url).toMatch(
        /^https:\/\/8080-my-project-[a-z0-9_]{16}\.example\.com\/?$/
      );
      expect(result.port).toBe(8080);
    });

    it('should construct valid URL with normalized ID', async () => {
      await sandbox.setSandboxName('myproject-123', true);

      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 4000,
        url: '',
        timestamp: '2023-01-01T00:00:00Z'
      });

      const result = await sandbox.exposePort(4000, { hostname: 'my-app.dev' });

      expect(result.url).toMatch(
        /^https:\/\/4000-myproject-123-[a-z0-9_]{16}\.my-app\.dev\/?$/
      );
      expect(result.port).toBe(4000);
    });

    it('should construct valid localhost URL', async () => {
      await sandbox.setSandboxName('test-sandbox', false);

      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        url: '',
        timestamp: '2023-01-01T00:00:00Z'
      });

      const result = await sandbox.exposePort(8080, {
        hostname: 'localhost:3000'
      });

      expect(result.url).toMatch(
        /^http:\/\/8080-test-sandbox-[a-z0-9_]{16}\.localhost:3000\/?$/
      );
    });

    it('should include helpful guidance in error message', async () => {
      await sandbox.setSandboxName('MyProject-ABC', false);

      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        url: '',
        timestamp: '2023-01-01T00:00:00Z'
      });

      await expect(
        sandbox.exposePort(8080, { hostname: 'example.com' })
      ).rejects.toThrow(
        /getSandbox\(ns, "MyProject-ABC", \{ normalizeId: true \}\)/
      );
    });
  });

  describe('timeout configuration validation', () => {
    it('should reject invalid timeout values', async () => {
      // NaN, Infinity, and out-of-range values should all be rejected
      await expect(
        sandbox.setContainerTimeouts({ instanceGetTimeoutMS: NaN })
      ).rejects.toThrow();

      await expect(
        sandbox.setContainerTimeouts({ portReadyTimeoutMS: Infinity })
      ).rejects.toThrow();

      await expect(
        sandbox.setContainerTimeouts({ instanceGetTimeoutMS: -1 })
      ).rejects.toThrow();

      await expect(
        sandbox.setContainerTimeouts({ waitIntervalMS: 999_999 })
      ).rejects.toThrow();
    });

    it('should accept valid timeout values', async () => {
      await expect(
        sandbox.setContainerTimeouts({
          instanceGetTimeoutMS: 30_000,
          portReadyTimeoutMS: 90_000,
          waitIntervalMS: 300
        })
      ).resolves.toBeUndefined();
    });
  });

  describe('custom token validation', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox', false);

      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        url: 'http://localhost:8080',
        timestamp: new Date().toISOString()
      });

      vi.mocked(mockCtx.storage!.get).mockResolvedValue({} as any);
      vi.mocked(mockCtx.storage!.put).mockResolvedValue(undefined);
    });

    it('should validate token format and length', async () => {
      const result = await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'abc_123_xyz'
      });
      expect(result.url).toContain('abc_123_xyz');

      await expect(
        sandbox.exposePort(8080, { hostname: 'example.com', token: '' })
      ).rejects.toThrow('Custom token cannot be empty');

      await expect(
        sandbox.exposePort(8080, {
          hostname: 'example.com',
          token: 'a1234567890123456'
        })
      ).rejects.toThrow('Maximum 16 characters');

      await expect(
        sandbox.exposePort(8080, { hostname: 'example.com', token: 'ABC123' })
      ).rejects.toThrow('lowercase letters');

      await expect(
        sandbox.exposePort(8080, { hostname: 'example.com', token: 'abc-123' })
      ).rejects.toThrow('underscores (_)');
    });

    it('should prevent token collision across different ports', async () => {
      await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'shared'
      });

      vi.mocked(mockCtx.storage!.get).mockResolvedValueOnce({
        '8080': 'shared'
      } as any);

      await expect(
        sandbox.exposePort(8081, { hostname: 'example.com', token: 'shared' })
      ).rejects.toThrow(/already in use by port 8080/);
    });

    it('should allow re-exposing same port with same token', async () => {
      await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'stable'
      });

      vi.mocked(mockCtx.storage!.get).mockResolvedValueOnce({
        '8080': 'stable'
      } as any);

      const result = await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'stable'
      });
      expect(result.url).toContain('stable');
    });
  });

  describe('sleepAfter configuration', () => {
    it('should call renewActivityTimeout when setSleepAfter is called', async () => {
      // Spy on renewActivityTimeout (inherited from Container)
      const renewSpy = vi.spyOn(sandbox as any, 'renewActivityTimeout');

      await sandbox.setSleepAfter('30m');

      // Verify sleepAfter was updated
      expect((sandbox as any).sleepAfter).toBe('30m');

      // Verify renewActivityTimeout was called to reschedule with new value
      expect(renewSpy).toHaveBeenCalled();
    });

    it('should accept numeric sleepAfter values', async () => {
      const renewSpy = vi.spyOn(sandbox as any, 'renewActivityTimeout');

      await sandbox.setSleepAfter(3600); // 1 hour in seconds

      expect((sandbox as any).sleepAfter).toBe(3600);
      expect(renewSpy).toHaveBeenCalled();
    });

    it('should persist sleepAfter to storage', async () => {
      await sandbox.setSleepAfter('30m');

      expect(mockCtx.storage.put).toHaveBeenCalledWith('sleepAfter', '30m');
    });

    it('should restore sleepAfter from storage on restart', async () => {
      const restartCtx = {
        ...mockCtx,
        storage: {
          ...mockCtx.storage,
          get: vi.fn().mockImplementation((key: string) => {
            if (key === 'sleepAfter') return Promise.resolve('30m');
            return Promise.resolve(null);
          }),
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue(new Map())
        } as any,
        blockConcurrencyWhile: vi
          .fn()
          .mockImplementation(
            <T>(callback: () => Promise<T>): Promise<T> => callback()
          )
      };

      const restored = new Sandbox(
        restartCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        mockEnv
      );

      await vi.waitFor(() => {
        expect((restored as any).sleepAfter).toBe('30m');
      });
    });
  });

  describe('constructor - interceptHttps env injection', () => {
    it('injects SANDBOX_INTERCEPT_HTTPS into envVars when interceptHttps is true', async () => {
      class SandboxWithHttps extends Sandbox<Record<string, unknown>> {
        override interceptHttps = true;
      }

      const customCtx = {
        ...mockCtx,
        blockConcurrencyWhile: vi
          .fn()
          .mockImplementation(
            <T>(callback: () => Promise<T>): Promise<T> => callback()
          ),
        storage: {
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue(new Map())
        } as any
      };

      const instance = new SandboxWithHttps(
        customCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        mockEnv
      );

      await vi.waitFor(() => {
        expect((instance as any).envVars.SANDBOX_INTERCEPT_HTTPS).toBe('1');
      });
    });

    it('does not inject SANDBOX_INTERCEPT_HTTPS when interceptHttps is false', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect(sandbox.envVars.SANDBOX_INTERCEPT_HTTPS).toBeUndefined();
    });

    it('preserves existing envVars entries when injecting', async () => {
      class SandboxWithHttps extends Sandbox<Record<string, unknown>> {
        override interceptHttps = true;
        override envVars: Record<string, string> = { MY_KEY: 'my-value' };
      }

      const customCtx = {
        ...mockCtx,
        blockConcurrencyWhile: vi
          .fn()
          .mockImplementation(
            <T>(callback: () => Promise<T>): Promise<T> => callback()
          ),
        storage: {
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue(new Map())
        } as any
      };

      const instance = new SandboxWithHttps(
        customCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        mockEnv
      );

      await vi.waitFor(() => {
        expect((instance as any).envVars.SANDBOX_INTERCEPT_HTTPS).toBe('1');
      });

      expect((instance as any).envVars.MY_KEY).toBe('my-value');
    });
  });

  describe('keepAlive configuration', () => {
    it('should reschedule activity timeout when keepAlive is disabled', async () => {
      const renewSpy = vi.spyOn(sandbox as any, 'renewActivityTimeout');

      await sandbox.setKeepAlive(true);
      expect(renewSpy).not.toHaveBeenCalled();

      await sandbox.setKeepAlive(false);

      expect(mockCtx.storage.put).toHaveBeenNthCalledWith(
        2,
        'keepAliveEnabled',
        false
      );
      expect(renewSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('backup path allowlist', () => {
    function createBackupBucket() {
      return {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
        head: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined)
      };
    }

    async function createBackupSandbox(bucket = createBackupBucket()) {
      const backupSandbox = new Sandbox(
        mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        {
          BACKUP_BUCKET: bucket,
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          R2_ACCESS_KEY_ID: 'test-key',
          R2_SECRET_ACCESS_KEY: 'test-secret',
          BACKUP_BUCKET_NAME: 'test-backups'
        }
      );

      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      return { backupSandbox, bucket };
    }

    it('should allow creating a backup from /app', async () => {
      const { backupSandbox, bucket } = await createBackupSandbox();

      vi.spyOn(backupSandbox.client.utils, 'createSession').mockResolvedValue({
        success: true,
        id: 'backup-session',
        message: 'Created'
      } as any);
      vi.spyOn(backupSandbox.client.utils, 'deleteSession').mockResolvedValue({
        success: true,
        id: 'backup-session',
        message: 'Deleted'
      } as any);
      const createArchiveSpy = vi
        .spyOn(backupSandbox.client.backup, 'createArchive')
        .mockResolvedValue({
          success: true,
          sizeBytes: 42,
          archivePath: '/var/backups/mock.sqsh'
        });
      vi.spyOn(backupSandbox as any, 'uploadBackupPresigned').mockResolvedValue(
        undefined
      );
      vi.spyOn(backupSandbox as any, 'execWithSession').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0
      });

      const backup = await backupSandbox.createBackup({ dir: '/app/project' });

      expect(backup.dir).toBe('/app/project');
      expect(createArchiveSpy).toHaveBeenCalledWith(
        '/app/project',
        expect.stringMatching(/^\/var\/backups\/.+\.sqsh$/),
        expect.stringMatching(/^__sandbox_backup_/),
        false,
        []
      );
      expect(bucket.put).toHaveBeenCalled();
    });

    it('should allow restoring a backup into /app', async () => {
      const { backupSandbox, bucket } = await createBackupSandbox();
      const backupId = crypto.randomUUID();

      bucket.get.mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          ttl: 259200,
          createdAt: new Date().toISOString(),
          dir: '/app/project'
        })
      });
      bucket.head.mockResolvedValue({ size: 42 });

      vi.spyOn(backupSandbox.client.utils, 'createSession').mockResolvedValue({
        success: true,
        id: 'backup-session',
        message: 'Created'
      } as any);
      vi.spyOn(backupSandbox.client.utils, 'deleteSession').mockResolvedValue({
        success: true,
        id: 'backup-session',
        message: 'Deleted'
      } as any);
      const restoreArchiveSpy = vi
        .spyOn(backupSandbox.client.backup, 'restoreArchive')
        .mockResolvedValue({ success: true, dir: '/app/project' });
      vi.spyOn(
        backupSandbox as any,
        'downloadBackupPresigned'
      ).mockResolvedValue(undefined);
      vi.spyOn(backupSandbox as any, 'execWithSession').mockResolvedValue({
        stdout: '0',
        stderr: '',
        exitCode: 0
      });

      const result = await backupSandbox.restoreBackup({
        id: backupId,
        dir: '/app/project'
      });

      expect(result).toEqual({
        success: true,
        dir: '/app/project',
        id: backupId
      });
      expect(restoreArchiveSpy).toHaveBeenCalledWith(
        '/app/project',
        `/var/backups/${backupId}.sqsh`,
        expect.stringMatching(/^__sandbox_backup_/)
      );
    });

    it('should reject unsupported backup roots before calling the container', async () => {
      const { backupSandbox } = await createBackupSandbox();
      const createArchiveSpy = vi.spyOn(
        backupSandbox.client.backup,
        'createArchive'
      );

      await expect(
        backupSandbox.createBackup({ dir: '/opt/project' })
      ).rejects.toThrow(
        /BackupOptions\.dir must be inside one of the supported backup roots/
      );

      expect(createArchiveSpy).not.toHaveBeenCalled();
    });
  });
});
