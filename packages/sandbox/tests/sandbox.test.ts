import { Container } from '@cloudflare/containers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortNotExposedError } from '../src/errors';
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
    async destroy(): Promise<void> {
      // No-op: real container destroy is not needed in tests; individual
      // tests that want to simulate destroy behavior use vi.spyOn.
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
    // Await the restore callback so tests observe a fully rehydrated instance.
    await Promise.all(
      (mockCtx.blockConcurrencyWhile as any).mock.results.map(
        (r: { value: unknown }) => r.value
      )
    );

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
        branch: 'main',
        cloneTimeoutMs: 90_000
      });

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);
      expect(sandbox.client.git.checkout).toHaveBeenCalledWith(
        'https://github.com/test/repo.git',
        expect.stringMatching(/^sandbox-/),
        {
          branch: 'main',
          targetDir: undefined,
          depth: undefined,
          timeoutMs: 90_000
        }
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

    it('coalesces concurrent callers onto one createSession RPC', async () => {
      let resolveCreate!: (value: unknown) => void;
      vi.mocked(sandbox.client.utils.createSession).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCreate = resolve;
        }) as any
      );

      const first = sandbox.exec('echo one');
      const second = sandbox.exec('echo two');

      resolveCreate({ success: true, id: 'sandbox-default', message: 'ok' });
      await Promise.all([first, second]);

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);
    });

    it('retries createSession after a failed initialization', async () => {
      vi.mocked(sandbox.client.utils.createSession)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({
          success: true,
          id: 'sandbox-default',
          message: 'ok'
        } as any);

      await expect(sandbox.exec('echo one')).rejects.toThrow('boom');
      await sandbox.exec('echo two');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(2);
    });

    it('does not cache the session id in memory if persistence fails', async () => {
      vi.mocked(mockCtx.storage.put).mockImplementation(async (key) => {
        if (key === 'defaultSession') throw new Error('storage down');
      });

      await expect(sandbox.exec('echo one')).rejects.toThrow('storage down');

      vi.mocked(mockCtx.storage.put).mockResolvedValue(undefined);
      await sandbox.exec('echo two');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(2);
    });

    it('does not share an in-flight init across different session ids', async () => {
      let resolveFirst!: (value: unknown) => void;
      let resolveSecond!: (value: unknown) => void;
      vi.mocked(sandbox.client.utils.createSession)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveFirst = resolve;
          }) as any
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveSecond = resolve;
          }) as any
        );

      const first = sandbox.exec('echo one');
      await sandbox.setSandboxName('renamed');
      const second = sandbox.exec('echo two');
      const third = sandbox.exec('echo three');

      resolveFirst({ success: true, id: 'sandbox-default', message: 'ok' });
      resolveSecond({ success: true, id: 'sandbox-renamed', message: 'ok' });
      await Promise.all([first, second, third]);

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(sandbox.client.commands.execute).mock.calls;
      expect(calls[0][1]).toBe('sandbox-default');
      expect(calls[1][1]).toBe('sandbox-renamed');
      expect(calls[2][1]).toBe('sandbox-renamed');
    });

    it('invalidates an in-flight init when onStop runs mid-flight', async () => {
      let resolveCreate!: (value: unknown) => void;
      vi.mocked(sandbox.client.utils.createSession).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCreate = resolve;
        }) as any
      );

      const inflight = sandbox.exec('echo one');
      await (sandbox as any).onStop();

      resolveCreate({ success: true, id: 'sandbox-default', message: 'ok' });
      await expect(inflight).rejects.toThrow();

      const defaultSessionPuts = vi
        .mocked(mockCtx.storage.put)
        .mock.calls.filter((call) => call[0] === 'defaultSession');
      expect(defaultSessionPuts).toHaveLength(0);
    });

    it('does not join a stale init promise after onStop clears it', async () => {
      let resolveFirst!: (value: unknown) => void;
      vi.mocked(sandbox.client.utils.createSession)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveFirst = resolve;
          }) as any
        )
        .mockResolvedValueOnce({
          success: true,
          id: 'sandbox-default',
          message: 'ok'
        } as any);

      const first = sandbox.exec('echo one');
      await (sandbox as any).onStop();
      const second = sandbox.exec('echo two');

      resolveFirst({ success: true, id: 'sandbox-default', message: 'ok' });
      await expect(first).rejects.toThrow();
      await second;

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(2);
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

  describe('placement id capture', () => {
    it('should store containerPlacementId from session-create response', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'sandbox-default',
        message: 'Created',
        containerPlacementId: 'placement-abc-123'
      } as any);

      await sandbox.exec('echo hi');

      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        'containerPlacementId',
        'placement-abc-123'
      );
    });

    it('should store null when container reports containerPlacementId as null', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'sandbox-default',
        message: 'Created',
        containerPlacementId: null
      } as any);

      await sandbox.exec('echo hi');

      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        'containerPlacementId',
        null
      );
    });

    it('should not touch containerPlacementId storage when response omits the field', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'sandbox-default',
        message: 'Created'
      } as any);

      await sandbox.exec('echo hi');

      const placementCalls = mockCtx.storage.put.mock.calls.filter(
        (call: unknown[]) => call[0] === 'containerPlacementId'
      );
      expect(placementCalls).toHaveLength(0);
    });

    it('getContainerPlacementId returns stored value', async () => {
      mockCtx.storage.get.mockImplementation(async (key: string) => {
        if (key === 'containerPlacementId') return 'placement-stored-xyz';
        return null;
      });

      await expect(sandbox.getContainerPlacementId()).resolves.toBe(
        'placement-stored-xyz'
      );
    });

    it('getContainerPlacementId returns undefined when no handshake has occurred', async () => {
      mockCtx.storage.get.mockResolvedValue(undefined);

      await expect(sandbox.getContainerPlacementId()).resolves.toBeUndefined();
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

      await session.gitCheckout('https://github.com/test/repo.git', {
        depth: 1,
        cloneTimeoutMs: 90_000
      });

      expect(sandbox.client.git.checkout).toHaveBeenCalledWith(
        'https://github.com/test/repo.git',
        'test-session',
        {
          branch: undefined,
          targetDir: undefined,
          depth: 1,
          timeoutMs: 90_000
        }
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

  describe('port restoration on container restart', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox', false);
      vi.spyOn(sandbox.client.ports, 'exposePort').mockResolvedValue({
        success: true,
        port: 8080,
        exposedAt: new Date().toISOString()
      } as any);
      vi.spyOn(sandbox.client.ports, 'getExposedPorts').mockResolvedValue({
        success: true,
        ports: [],
        count: 0,
        timestamp: new Date().toISOString()
      } as any);
    });

    it('should re-expose saved ports with their friendly names when the container starts', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens'
          ? {
              '8080': { token: 'tok8080', name: 'api' },
              '9000': { token: 'tok9000', name: 'admin' }
            }
          : null
      );

      await (sandbox as any).restoreExposedPorts();

      expect(sandbox.client.ports.exposePort).toHaveBeenCalledTimes(2);
      expect(sandbox.client.ports.exposePort).toHaveBeenCalledWith(
        8080,
        expect.any(String),
        'api'
      );
      expect(sandbox.client.ports.exposePort).toHaveBeenCalledWith(
        9000,
        expect.any(String),
        'admin'
      );
    });

    it('should migrate legacy string-only storage entries on restore', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens' ? { '8080': 'legacytoken1234' } : null
      );

      await (sandbox as any).restoreExposedPorts();

      expect(sandbox.client.ports.exposePort).toHaveBeenCalledWith(
        8080,
        expect.any(String),
        undefined
      );
    });

    it('should skip ports the container already reports as exposed', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens' ? { '8080': { token: 'tok8080' } } : null
      );
      vi.mocked(sandbox.client.ports.getExposedPorts as any).mockResolvedValue({
        success: true,
        ports: [{ port: 8080, status: 'active' }],
        count: 1,
        timestamp: new Date().toISOString()
      } as any);

      await (sandbox as any).restoreExposedPorts();

      expect(sandbox.client.ports.exposePort).not.toHaveBeenCalled();
    });

    it('should continue restoring other ports when one fails', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens'
          ? {
              '8080': { token: 'tok8080' },
              '9000': { token: 'tok9000' }
            }
          : null
      );
      vi.mocked(sandbox.client.ports.exposePort as any)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({
          success: true,
          port: 9000,
          exposedAt: new Date().toISOString()
        } as any);

      await (sandbox as any).restoreExposedPorts();

      // First call failed, second succeeded — both were attempted.
      expect(sandbox.client.ports.exposePort).toHaveBeenCalledTimes(2);
    });

    it('onStop() must preserve portTokens so restore has something to read', async () => {
      await (sandbox as any).onStop();

      // Nothing in the onStop path should delete portTokens.
      const deletedKeys = vi
        .mocked(mockCtx.storage!.delete)
        .mock.calls.map((call) => call[0]);
      expect(deletedKeys).not.toContain('portTokens');
    });

    it('destroy() deletes portTokens before calling super.destroy()', async () => {
      const callOrder: string[] = [];

      vi.mocked(mockCtx.storage!.delete).mockImplementation(async (key) => {
        callOrder.push(`delete:${String(key)}`);
      });

      vi.spyOn(Container.prototype, 'destroy').mockImplementation(async () => {
        callOrder.push('super.destroy');
      });

      await sandbox.destroy();

      // super.destroy() is not serialized by blockConcurrencyWhile, so a
      // concurrent validatePortToken() or start path can run during the
      // await. This test pins the ordering that keeps stale reads out of
      // that window: portTokens deletion before super.destroy().
      const deleteIdx = callOrder.indexOf('delete:portTokens');
      const superIdx = callOrder.indexOf('super.destroy');

      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(superIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeLessThan(superIdx);
    });

    it('exposePort() persists the friendly name alongside the token', async () => {
      vi.mocked(mockCtx.storage!.get).mockResolvedValue({} as any);
      const putSpy = vi.mocked(mockCtx.storage!.put);

      await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'friendlytok',
        name: 'my-api'
      });

      const portsPut = putSpy.mock.calls.find(
        (call) => call[0] === 'portTokens'
      );
      expect(portsPut).toBeDefined();
      expect(portsPut?.[1]).toEqual({
        '8080': { token: 'friendlytok', name: 'my-api' }
      });
    });

    it('onStart() swallows restoreExposedPorts() errors so startup succeeds', async () => {
      // Simulate a saved port whose restore will fail — getExposedPorts
      // returning something unparseable forces the inner logic to throw.
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens' ? { '8080': { token: 'tok8080' } } : null
      );
      vi.spyOn(sandbox as any, 'restoreExposedPorts').mockRejectedValue(
        new Error('restore boom')
      );
      const errorSpy = vi.spyOn((sandbox as any).logger, 'error');

      // onStart must not throw; the base class wraps this in
      // blockConcurrencyWhile, and an unhandled rejection there would
      // reset the DO. Instead, onStart catches, logs, and returns.
      await expect((sandbox as any).onStart()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to restore exposed ports after container start',
        expect.any(Error)
      );
    });

    it('fetches the exposed-port snapshot once per restore', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens'
          ? {
              '8080': { token: 'tok8080' },
              '9000': { token: 'tok9000' },
              '9100': { token: 'tok9100' }
            }
          : null
      );

      await (sandbox as any).restoreExposedPorts();

      expect(sandbox.client.ports.getExposedPorts).toHaveBeenCalledTimes(1);
    });

    it('falls back to attempting exposePort for all ports when getExposedPorts rejects', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens'
          ? {
              '8080': { token: 'tok8080' },
              '9000': { token: 'tok9000' }
            }
          : null
      );
      vi.mocked(sandbox.client.ports.getExposedPorts as any).mockRejectedValue(
        new Error('snapshot unavailable')
      );

      await (sandbox as any).restoreExposedPorts();

      // With no snapshot, every saved port is attempted — the per-port
      // failure path catches individual errors, and this preserves the
      // prior "best-effort restore" semantics.
      expect(sandbox.client.ports.exposePort).toHaveBeenCalledTimes(2);
      expect(sandbox.client.ports.exposePort).toHaveBeenCalledWith(
        8080,
        expect.any(String),
        undefined
      );
      expect(sandbox.client.ports.exposePort).toHaveBeenCalledWith(
        9000,
        expect.any(String),
        undefined
      );
    });
  });

  describe('validatePortToken', () => {
    beforeEach(() => {
      // Spy on getExposedPorts so a regression that reintroduces the
      // container round-trip is catchable via not.toHaveBeenCalled().
      vi.spyOn(sandbox.client.ports, 'getExposedPorts').mockResolvedValue({
        success: true,
        ports: [],
        count: 0,
        timestamp: new Date().toISOString()
      } as any);

      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) =>
        key === 'portTokens' ? { '8080': { token: 'correcttoken' } } : null
      );
    });

    it('returns true for a matching token without calling the container', async () => {
      const result = await sandbox.validatePortToken(8080, 'correcttoken');

      expect(result).toBe(true);
      expect(sandbox.client.ports.getExposedPorts).not.toHaveBeenCalled();
    });

    it('returns false for a mismatched token', async () => {
      const result = await sandbox.validatePortToken(8080, 'wrongtoken');

      expect(result).toBe(false);
    });

    it('returns false when no token is stored for the port', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) =>
        key === 'portTokens' ? {} : null
      );

      const result = await sandbox.validatePortToken(8080, 'anytoken');

      expect(result).toBe(false);
    });

    it('accepts legacy string-valued tokens from storage', async () => {
      // readPortTokens normalizes the { port: string } storage shape
      // to { port: { token: string } }; legacy entries must still
      // authenticate.
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) =>
        key === 'portTokens' ? { '8080': 'legacytoken' } : null
      );

      const result = await sandbox.validatePortToken(8080, 'legacytoken');

      expect(result).toBe(true);
    });

    it('does not call isPortExposed', async () => {
      const spy = vi.spyOn(sandbox, 'isPortExposed');

      await sandbox.validatePortToken(8080, 'correcttoken');

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('unexposePort ordering', () => {
    beforeEach(() => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) =>
        key === 'portTokens' ? { '8080': { token: 'sometoken' } } : null
      );
      vi.spyOn(sandbox.client.ports, 'unexposePort').mockResolvedValue(
        undefined as any
      );
    });

    it('revokes the token from storage before the container RPC', async () => {
      const calls: string[] = [];
      vi.mocked(mockCtx.storage.put).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          calls.push('storage');
        }
      });
      vi.mocked(sandbox.client.ports.unexposePort).mockImplementation(
        async () => {
          calls.push('container');
          return {
            success: true,
            port: 8080,
            timestamp: new Date().toISOString()
          };
        }
      );

      await sandbox.unexposePort(8080);

      expect(calls).toEqual(['storage', 'container']);
    });

    it('treats PortNotExposedError from the container as success', async () => {
      vi.mocked(sandbox.client.ports.unexposePort).mockRejectedValue(
        new PortNotExposedError({
          error: 'Port not exposed: 8080',
          code: 'PORT_NOT_EXPOSED',
          context: { port: 8080 }
        } as any)
      );

      await expect(sandbox.unexposePort(8080)).resolves.toBeUndefined();
      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        'portTokens',
        expect.not.objectContaining({ '8080': expect.anything() })
      );
    });

    it('rethrows non-PortNotExposedError failures from the container', async () => {
      vi.mocked(sandbox.client.ports.unexposePort).mockRejectedValue(
        new Error('network failure')
      );

      await expect(sandbox.unexposePort(8080)).rejects.toThrow(
        'network failure'
      );
    });
  });

  describe('getExposedPorts orphan handling', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox');

      vi.spyOn(sandbox.client.ports, 'getExposedPorts').mockResolvedValue({
        success: true,
        ports: [
          { port: 8080, exposedAt: new Date().toISOString() },
          { port: 9090, exposedAt: new Date().toISOString() }
        ],
        count: 2,
        timestamp: new Date().toISOString()
      } as any);

      // Storage has a token for 9090 but not for 8080, so 8080 is an
      // orphan from getExposedPorts()'s perspective.
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'portTokens') return { '9090': { token: 'token9090' } };
        if (key === 'sandboxName') return 'test-sandbox';
        return null;
      });
    });

    it('omits ports with no token from the result', async () => {
      const warnSpy = vi.spyOn((sandbox as any).logger, 'warn');

      const result = await sandbox.getExposedPorts('example.com');

      expect(result).toHaveLength(1);
      expect(result[0].port).toBe(9090);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no token in storage'),
        expect.objectContaining({ port: 8080 })
      );
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

    it('is a no-op when sleepAfter matches current value', async () => {
      await sandbox.setSleepAfter('30m');
      const putCallsBefore = mockCtx.storage.put.mock.calls.length;
      const renewSpy = vi.spyOn(sandbox as any, 'renewActivityTimeout');

      await sandbox.setSleepAfter('30m');

      expect(mockCtx.storage.put.mock.calls.length).toBe(putCallsBefore);
      expect(renewSpy).not.toHaveBeenCalled();
    });

    it('leaves in-memory state unchanged when storage.put fails', async () => {
      const before = (sandbox as any).sleepAfter;
      vi.mocked(mockCtx.storage.put).mockRejectedValueOnce(
        new Error('simulated storage failure')
      );

      await expect(sandbox.setSleepAfter('45m')).rejects.toThrow(
        'simulated storage failure'
      );

      expect((sandbox as any).sleepAfter).toBe(before);
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

    it('is a no-op when setKeepAlive(false) is called on an already-disabled sandbox', async () => {
      await sandbox.setKeepAlive(true);
      await sandbox.setKeepAlive(false);
      const putCallsBefore = mockCtx.storage.put.mock.calls.length;
      const renewSpy = vi.spyOn(sandbox as any, 'renewActivityTimeout');

      await sandbox.setKeepAlive(false);

      expect(mockCtx.storage.put.mock.calls.length).toBe(putCallsBefore);
      expect(renewSpy).not.toHaveBeenCalled();
    });
  });

  describe('containerTimeouts configuration', () => {
    // The in-memory defaults come from env vars with SDK fallbacks. A first
    // explicit call whose values happen to equal those defaults must still
    // persist so the user's intent is recorded independently of whatever the
    // env currently resolves to. A subsequent identical call is then a no-op.
    it('persists on first explicit call even when values match current in-memory defaults', async () => {
      const current = { ...(sandbox as any).containerTimeouts };

      await sandbox.setContainerTimeouts(current);

      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        'containerTimeouts',
        expect.objectContaining(current)
      );

      const putCallsBefore = mockCtx.storage.put.mock.calls.length;
      const setRetrySpy = vi.spyOn(sandbox.client, 'setRetryTimeoutMs');
      await sandbox.setContainerTimeouts(current);
      expect(mockCtx.storage.put.mock.calls.length).toBe(putCallsBefore);
      expect(setRetrySpy).not.toHaveBeenCalled();
    });
  });

  describe('setSandboxName atomicity', () => {
    // sandboxName and normalizeId are written together; if the second write
    // rejects, in-memory state must match storage (both unchanged).
    it('leaves in-memory state unchanged when the second of the two writes fails', async () => {
      let callCount = 0;
      vi.mocked(mockCtx.storage.put).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('simulated storage failure');
        return undefined;
      });

      const beforeSandboxName = (sandbox as any).sandboxName;
      const beforeNormalizeId = (sandbox as any).normalizeId;

      await expect(sandbox.setSandboxName('my-sandbox', true)).rejects.toThrow(
        'simulated storage failure'
      );

      expect((sandbox as any).sandboxName).toBe(beforeSandboxName);
      expect((sandbox as any).normalizeId).toBe(beforeNormalizeId);
    });
  });

  describe('configure() idempotency', () => {
    // getSandbox re-invokes configure() on every cold-isolate cache miss.
    // Identical reapply must be side-effect-free.
    it('does not renew activity timeout on a repeated identical configure call', async () => {
      const renewSpy = vi.spyOn(sandbox as any, 'renewActivityTimeout');

      await sandbox.configure({ sleepAfter: '3s' });
      const renewCallsAfterFirst = renewSpy.mock.calls.length;
      expect(renewCallsAfterFirst).toBeGreaterThan(0);

      await sandbox.configure({ sleepAfter: '3s' });

      expect(renewSpy.mock.calls.length).toBe(renewCallsAfterFirst);
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
        { gitignore: false, excludes: [] }
      );
      expect(bucket.put).toHaveBeenCalled();
    });

    it('should normalize globstar excludes before calling createArchive', async () => {
      const { backupSandbox } = await createBackupSandbox();

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

      await backupSandbox.createBackup({
        dir: '/app/project',
        excludes: ['**/node_modules/.cache', '**/.next/cache', 'dist/**', '**']
      });

      expect(createArchiveSpy).toHaveBeenCalledWith(
        '/app/project',
        expect.stringMatching(/^\/var\/backups\/.+\.sqsh$/),
        expect.stringMatching(/^__sandbox_backup_/),
        {
          gitignore: false,
          excludes: ['node_modules/.cache', '.next/cache', 'dist']
        }
      );
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
      const mountBackupR2Spy = vi
        .spyOn(backupSandbox as any, 'mountBackupR2')
        .mockResolvedValue(undefined);
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
        `/var/backups/r2mount/${backupId}/data.sqsh`,
        expect.stringMatching(/^__sandbox_backup_/)
      );
      expect(mountBackupR2Spy).toHaveBeenCalledWith(
        `/var/backups/r2mount/${backupId}`,
        `backups/${backupId}/`,
        expect.stringMatching(/^__sandbox_backup_/)
      );
      expect(
        (backupSandbox as any).execWithSession.mock.calls.some(
          ([command]: [string]) =>
            command.includes(
              `/usr/bin/fusermount3 -uz '/var/backups/r2mount/${backupId}'`
            )
        )
      ).toBe(true);
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

  describe('transport configuration', () => {
    it('defaults to http transport', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect((sandbox as any).transport).toBe('http');
      expect(sandbox.client.getTransportMode()).toBe('http');
    });

    it('reads websocket transport from SANDBOX_TRANSPORT env var', async () => {
      const wsCtx = {
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

      const instance = new Sandbox(
        wsCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        { SANDBOX_TRANSPORT: 'websocket' }
      );

      await vi.waitFor(() => {
        expect(wsCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect((instance as any).transport).toBe('websocket');
      expect(instance.client.getTransportMode()).toBe('websocket');
    });

    it('setTransport switches from http to websocket', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect((sandbox as any).transport).toBe('http');

      await sandbox.setTransport('websocket');

      expect((sandbox as any).transport).toBe('websocket');
      expect(sandbox.client.getTransportMode()).toBe('websocket');
    });

    it('setTransport switches from websocket to http', async () => {
      const wsCtx = {
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

      const instance = new Sandbox(
        wsCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        { SANDBOX_TRANSPORT: 'websocket' }
      );

      await vi.waitFor(() => {
        expect(wsCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect((instance as any).transport).toBe('websocket');

      await instance.setTransport('http');

      expect((instance as any).transport).toBe('http');
      expect(instance.client.getTransportMode()).toBe('http');
    });

    it('setTransport is a no-op when transport has been stored and value is unchanged', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      // First call persists (hasStoredTransport is false)
      await sandbox.setTransport('http');
      const putCallsAfterFirst = mockCtx.storage.put.mock.calls.length;
      const clientBefore = sandbox.client;

      // Second identical call is a no-op
      await sandbox.setTransport('http');

      expect(mockCtx.storage.put.mock.calls.length).toBe(putCallsAfterFirst);
      expect(sandbox.client).toBe(clientBefore);
    });

    it('setTransport recreates the client with new transport', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      const clientBefore = sandbox.client;

      await sandbox.setTransport('websocket');

      // Client should be a new instance
      expect(sandbox.client).not.toBe(clientBefore);
    });

    it('setTransport recreates the CodeInterpreter so it uses the new client', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      const interpreterBefore = (sandbox as any).codeInterpreter;

      await sandbox.setTransport('websocket');

      const interpreterAfter = (sandbox as any).codeInterpreter;
      expect(interpreterAfter).not.toBe(interpreterBefore);
    });

    it('setTransport disconnects the previous client', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      const previousClient = sandbox.client;
      const disconnectSpy = vi.spyOn(previousClient, 'disconnect');

      await sandbox.setTransport('websocket');

      expect(disconnectSpy).toHaveBeenCalledOnce();
    });

    it('persists transport to storage before updating in-memory state', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      await sandbox.setTransport('websocket');

      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        'transport',
        'websocket'
      );
    });

    it('persists on first explicit call even when value matches env-derived default', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      // Default transport is 'http'; calling setTransport('http') must still persist
      await sandbox.setTransport('http');

      expect(mockCtx.storage.put).toHaveBeenCalledWith('transport', 'http');

      // Second identical call is a no-op
      const putCallsBefore = mockCtx.storage.put.mock.calls.length;
      await sandbox.setTransport('http');
      expect(mockCtx.storage.put.mock.calls.length).toBe(putCallsBefore);
    });

    it('restores transport from storage on cold start, overriding env var', async () => {
      const coldCtx = {
        ...mockCtx,
        blockConcurrencyWhile: vi
          .fn()
          .mockImplementation(
            <T>(callback: () => Promise<T>): Promise<T> => callback()
          ),
        storage: {
          get: vi.fn().mockImplementation(async (key: string) => {
            if (key === 'transport') return 'websocket';
            return null;
          }),
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue(new Map())
        } as any
      };

      // Env says 'http' but storage says 'websocket'
      const instance = new Sandbox(
        coldCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        {}
      );

      await vi.waitFor(() => {
        expect(coldCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });
      await Promise.all(
        (coldCtx.blockConcurrencyWhile as any).mock.results.map(
          (r: { value: unknown }) => r.value
        )
      );

      expect((instance as any).transport).toBe('websocket');
      expect((instance as any).hasStoredTransport).toBe(true);
      expect(instance.client.getTransportMode()).toBe('websocket');
    });

    it('reads rpc transport from SANDBOX_TRANSPORT env var', async () => {
      const rpcCtx = {
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

      const instance = new Sandbox(
        rpcCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        { SANDBOX_TRANSPORT: 'rpc' }
      );

      await vi.waitFor(() => {
        expect(rpcCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect((instance as any).transport).toBe('rpc');
      expect(instance.client.getTransportMode()).toBe('rpc');
    });

    it('setTransport switches from http to rpc', async () => {
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect((sandbox as any).transport).toBe('http');

      await sandbox.setTransport('rpc');

      expect((sandbox as any).transport).toBe('rpc');
      expect(sandbox.client.getTransportMode()).toBe('rpc');
    });

    it('setTransport switches from rpc to http', async () => {
      const rpcCtx = {
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

      const instance = new Sandbox(
        rpcCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        { SANDBOX_TRANSPORT: 'rpc' }
      );

      await vi.waitFor(() => {
        expect(rpcCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      expect((instance as any).transport).toBe('rpc');

      await instance.setTransport('http');

      expect((instance as any).transport).toBe('http');
      expect(instance.client.getTransportMode()).toBe('http');
    });

    it('restores rpc transport from storage on cold start', async () => {
      const coldCtx = {
        ...mockCtx,
        blockConcurrencyWhile: vi
          .fn()
          .mockImplementation(
            <T>(callback: () => Promise<T>): Promise<T> => callback()
          ),
        storage: {
          get: vi.fn().mockImplementation(async (key: string) => {
            if (key === 'transport') return 'rpc';
            return null;
          }),
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue(new Map())
        } as any
      };

      const instance = new Sandbox(
        coldCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        {}
      );

      await vi.waitFor(() => {
        expect(coldCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });
      await Promise.all(
        (coldCtx.blockConcurrencyWhile as any).mock.results.map(
          (r: { value: unknown }) => r.value
        )
      );

      expect((instance as any).transport).toBe('rpc');
      expect((instance as any).hasStoredTransport).toBe(true);
      expect(instance.client.getTransportMode()).toBe('rpc');
    });

    it('storage restore does not override env-derived rpc with stored http', async () => {
      const coldCtx = {
        ...mockCtx,
        blockConcurrencyWhile: vi
          .fn()
          .mockImplementation(
            <T>(callback: () => Promise<T>): Promise<T> => callback()
          ),
        storage: {
          get: vi.fn().mockImplementation(async (key: string) => {
            // Storage has 'http' but env says 'rpc'
            if (key === 'transport') return 'http';
            return null;
          }),
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue(new Map())
        } as any
      };

      const instance = new Sandbox(
        coldCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        { SANDBOX_TRANSPORT: 'rpc' }
      );

      await vi.waitFor(() => {
        expect(coldCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });
      await Promise.all(
        (coldCtx.blockConcurrencyWhile as any).mock.results.map(
          (r: { value: unknown }) => r.value
        )
      );

      // Storage says 'http' which differs from env 'rpc', so storage wins
      expect((instance as any).transport).toBe('http');
      expect((instance as any).hasStoredTransport).toBe(true);
    });
  });

  describe('destroy() coalescing', () => {
    /**
     * Stub the parent Container.destroy() with a caller-controlled promise so
     * we can observe how concurrent destroy() calls behave while the first
     * one is still in flight.
     */
    function stubSuperDestroy(): {
      resolve: () => void;
      reject: (err: Error) => void;
      calls: () => number;
    } {
      let resolve: () => void = () => {};
      let reject: (err: Error) => void = () => {};
      let calls = 0;
      const parent = Object.getPrototypeOf(Object.getPrototypeOf(sandbox)) as {
        destroy: () => Promise<void>;
      };
      parent.destroy = vi.fn().mockImplementation(
        () =>
          new Promise<void>((res, rej) => {
            calls++;
            resolve = res;
            reject = rej;
          })
      );
      return {
        resolve: () => resolve(),
        reject: (err) => reject(err),
        calls: () => calls
      };
    }

    it('coalesces concurrent destroy() calls onto a single teardown', async () => {
      const superDestroy = stubSuperDestroy();

      const first = sandbox.destroy();
      const second = sandbox.destroy();
      const third = sandbox.destroy();

      // All three callers are awaiting the same underlying work; the parent
      // container destroy must only be invoked once.
      expect(superDestroy.calls()).toBe(1);

      superDestroy.resolve();
      await expect(Promise.all([first, second, third])).resolves.toEqual([
        undefined,
        undefined,
        undefined
      ]);
    });

    it('propagates the same rejection to all coalesced callers', async () => {
      const superDestroy = stubSuperDestroy();
      const first = sandbox.destroy();
      const second = sandbox.destroy();

      superDestroy.reject(new Error('container teardown failed'));

      await expect(first).rejects.toThrow('container teardown failed');
      await expect(second).rejects.toThrow('container teardown failed');
    });

    it('runs a fresh teardown for a later destroy() after the previous one settles', async () => {
      const first = stubSuperDestroy();
      const firstCall = sandbox.destroy();
      expect(first.calls()).toBe(1);
      first.resolve();
      await firstCall;

      // Re-stub to track the second teardown independently.
      const second = stubSuperDestroy();
      const secondCall = sandbox.destroy();
      expect(second.calls()).toBe(1);
      second.resolve();
      await secondCall;
    });
  });
});
