import type { DurableObjectState } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';

// Mock dependencies before imports
vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cloudflare/containers', () => ({
  Container: class Container {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  getContainer: vi.fn(),
}));

describe('Sandbox - Automatic Session Management', () => {
  let sandbox: Sandbox;
  let mockCtx: Partial<DurableObjectState>;
  let mockEnv: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock DurableObjectState
    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map()),
      } as any,
      blockConcurrencyWhile: vi.fn().mockImplementation(<T>(callback: () => Promise<T>): Promise<T> => callback()),
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox',
      } as any,
    };

    mockEnv = {};

    // Create Sandbox instance - SandboxClient is created internally
    sandbox = new Sandbox(mockCtx as DurableObjectState, mockEnv);

    // Wait for blockConcurrencyWhile to complete
    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    // Now spy on the client methods that we need for testing
    vi.spyOn(sandbox.client.utils, 'createSession').mockResolvedValue({
      success: true,
      id: 'sandbox-default',
      message: 'Created',
    } as any);

    vi.spyOn(sandbox.client.commands, 'execute').mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      command: '',
      timestamp: new Date().toISOString(),
    } as any);

    vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
      success: true,
      path: '/test.txt',
      timestamp: new Date().toISOString(),
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
        timestamp: new Date().toISOString(),
      } as any);

      await sandbox.exec('echo test');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);
      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: expect.stringMatching(/^sandbox-/),
        env: {},
        cwd: '/workspace',
      });

      expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
        'echo test',
        expect.stringMatching(/^sandbox-/)
      );
    });

    it('should reuse default session across multiple operations', async () => {
      await sandbox.exec('echo test1');
      await sandbox.writeFile('/test.txt', 'content');
      await sandbox.exec('echo test2');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);

      const firstSessionId = vi.mocked(sandbox.client.commands.execute).mock.calls[0][1];
      const fileSessionId = vi.mocked(sandbox.client.files.writeFile).mock.calls[0][2];
      const secondSessionId = vi.mocked(sandbox.client.commands.execute).mock.calls[1][1];

      expect(firstSessionId).toBe(fileSessionId);
      expect(firstSessionId).toBe(secondSessionId);
    });

    it('should use default session for process management', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-1',
        pid: 1234,
        command: 'sleep 10',
        timestamp: new Date().toISOString(),
      } as any);

      vi.spyOn(sandbox.client.processes, 'listProcesses').mockResolvedValue({
        success: true,
        processes: [{
          id: 'proc-1',
          pid: 1234,
          command: 'sleep 10',
          status: 'running',
          startTime: new Date().toISOString(),
        }],
        timestamp: new Date().toISOString(),
      } as any);

      const process = await sandbox.startProcess('sleep 10');
      const processes = await sandbox.listProcesses();

      expect(sandbox.client.utils.createSession).toHaveBeenCalledTimes(1);

      // startProcess uses sessionId (to start process in that session)
      const startSessionId = vi.mocked(sandbox.client.processes.startProcess).mock.calls[0][1];
      expect(startSessionId).toMatch(/^sandbox-/);

      // listProcesses is sandbox-scoped - no sessionId parameter
      const listProcessesCall = vi.mocked(sandbox.client.processes.listProcesses).mock.calls[0];
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
        timestamp: new Date().toISOString(),
      } as any);

      await sandbox.gitCheckout('https://github.com/test/repo.git', { branch: 'main' });

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

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: 'sandbox-my-sandbox',
        env: {},
        cwd: '/workspace',
      });
    });
  });

  describe('explicit session creation', () => {
    it('should create isolated execution session', async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'custom-session-123',
        message: 'Created',
      } as any);

      const session = await sandbox.createSession({
        id: 'custom-session-123',
        env: { NODE_ENV: 'test' },
        cwd: '/test',
      });

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: 'custom-session-123',
        env: { NODE_ENV: 'test' },
        cwd: '/test',
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
        message: 'Created',
      } as any);

      const session = await sandbox.createSession({ id: 'isolated-session' });

      await session.exec('echo test');

      expect(sandbox.client.commands.execute).toHaveBeenCalledWith(
        'echo test',
        'isolated-session'
      );
    });

    it('should isolate multiple explicit sessions', async () => {
      vi.mocked(sandbox.client.utils.createSession)
        .mockResolvedValueOnce({ success: true, id: 'session-1', message: 'Created' } as any)
        .mockResolvedValueOnce({ success: true, id: 'session-2', message: 'Created' } as any);

      const session1 = await sandbox.createSession({ id: 'session-1' });
      const session2 = await sandbox.createSession({ id: 'session-2' });

      await session1.exec('echo build');
      await session2.exec('echo test');

      const session1Id = vi.mocked(sandbox.client.commands.execute).mock.calls[0][1];
      const session2Id = vi.mocked(sandbox.client.commands.execute).mock.calls[1][1];

      expect(session1Id).toBe('session-1');
      expect(session2Id).toBe('session-2');
      expect(session1Id).not.toBe(session2Id);
    });

    it('should not interfere with default session', async () => {
      vi.mocked(sandbox.client.utils.createSession)
        .mockResolvedValueOnce({ success: true, id: 'sandbox-default', message: 'Created' } as any)
        .mockResolvedValueOnce({ success: true, id: 'explicit-session', message: 'Created' } as any);

      await sandbox.exec('echo default');

      const explicitSession = await sandbox.createSession({ id: 'explicit-session' });
      await explicitSession.exec('echo explicit');

      await sandbox.exec('echo default-again');

      const defaultSessionId1 = vi.mocked(sandbox.client.commands.execute).mock.calls[0][1];
      const explicitSessionId = vi.mocked(sandbox.client.commands.execute).mock.calls[1][1];
      const defaultSessionId2 = vi.mocked(sandbox.client.commands.execute).mock.calls[2][1];

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
        message: 'Created',
      } as any);

      await sandbox.createSession();

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: expect.stringMatching(/^session-/),
        env: undefined,
        cwd: undefined,
      });
    });
  });

  describe('ExecutionSession operations', () => {
    let session: any;

    beforeEach(async () => {
      vi.mocked(sandbox.client.utils.createSession).mockResolvedValueOnce({
        success: true,
        id: 'test-session',
        message: 'Created',
      } as any);

      session = await sandbox.createSession({ id: 'test-session' });
    });

    it('should execute command with session context', async () => {
      await session.exec('pwd');
      expect(sandbox.client.commands.execute).toHaveBeenCalledWith('pwd', 'test-session');
    });

    it('should start process with session context', async () => {
      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        process: {
          id: 'proc-1',
          pid: 1234,
          command: 'sleep 10',
          status: 'running',
          startTime: new Date().toISOString(),
        },
      } as any);

      await session.startProcess('sleep 10');

      expect(sandbox.client.processes.startProcess).toHaveBeenCalledWith(
        'sleep 10',
        'test-session',
        { processId: undefined }
      );
    });

    it('should write file with session context', async () => {
      vi.spyOn(sandbox.client.files, 'writeFile').mockResolvedValue({
        success: true,
        path: '/test.txt',
        timestamp: new Date().toISOString(),
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
        timestamp: new Date().toISOString(),
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

      await expect(sandbox.exec('echo test')).rejects.toThrow('Session creation failed');
    });

    it('should initialize with empty environment when not set', async () => {
      await sandbox.exec('pwd');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: expect.any(String),
        env: {},
        cwd: '/workspace',
      });
    });

    it('should use updated environment after setEnvVars', async () => {
      await sandbox.setEnvVars({ NODE_ENV: 'production', DEBUG: 'true' });

      await sandbox.exec('env');

      expect(sandbox.client.utils.createSession).toHaveBeenCalledWith({
        id: expect.any(String),
        env: { NODE_ENV: 'production', DEBUG: 'true' },
        cwd: '/workspace',
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
        exposedAt: new Date().toISOString(),
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
        const result = await sandbox.exposePort(8080, { name: 'test', hostname });
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

  describe('Health checks', () => {
    beforeEach(() => {
      // Mock Container base class getState method for health checks
      (sandbox as any).getState = vi.fn().mockResolvedValue({
        status: 'running',
        timestamp: new Date().toISOString(),
      });
    });


    it('should detect container crashes during streaming', async () => {
      vi.useFakeTimers();

      // Create a stream that will trigger health check
      const encoder = new TextEncoder();
      const mockStream = new ReadableStream({
        async start(controller) {
          // Enqueue initial chunk
          controller.enqueue(encoder.encode('starting\n'));
          // Keep stream open
        }
      });

      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(mockStream);

      // Make getState return unhealthy status
      (sandbox as any).getState = vi.fn().mockResolvedValue({
        status: 'stopped',
        timestamp: new Date().toISOString(),
      });

      const stream = await sandbox.execStream('echo test');
      const reader = stream.getReader();

      // Read first chunk
      await reader.read();

      // Advance time to trigger health check (30 seconds)
      await vi.advanceTimersByTimeAsync(31000);

      // Verify health check was called
      expect((sandbox as any).getState).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should timeout on hung streams', async () => {
      vi.useFakeTimers();

      // Create a stream that never resolves
      const mockStream = new ReadableStream({
        async start(controller) {
          // Never enqueue anything - stream hangs
          await new Promise(() => {}); // Never resolves
        }
      });

      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(mockStream);

      const streamPromise = sandbox.execStream('sleep infinity');
      const stream = await streamPromise;
      const reader = stream.getReader();

      // Start reading
      const readPromise = reader.read();

      // Fast-forward past the timeout (5 minutes = 300000ms)
      vi.advanceTimersByTime(300001);

      // Should reject with timeout error
      await expect(readPromise).rejects.toThrow(/Stream read timeout/);

      vi.useRealTimers();
    });

    it('should cleanup intervals on stream completion', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const encoder = new TextEncoder();
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('test\n'));
          controller.close();
        }
      });

      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(mockStream);

      const stream = await sandbox.execStream('echo test');
      const reader = stream.getReader();

      // Read until done
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Verify interval was cleared
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('should cleanup intervals on stream cancellation', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const encoder = new TextEncoder();
      let underlyingReader: any;
      const mockStream = new ReadableStream({
        async start(controller) {
          underlyingReader = {
            cancel: async () => {
              // Mock cancel
            }
          };
          // Emit chunks indefinitely
          for (let i = 0; i < 100; i++) {
            controller.enqueue(encoder.encode(`chunk ${i}\n`));
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          controller.close();
        },
        cancel() {
          // Mock cancel
        }
      });

      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(mockStream);

      const stream = await sandbox.execStream('echo test');
      const reader = stream.getReader();

      // Read one chunk
      await reader.read();

      // Cancel the stream
      try {
        await reader.cancel('user cancellation');
      } catch (e) {
        // Ignore cancellation errors in test
      }

      // Verify interval was cleared on cancellation
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('should handle health check failures gracefully', async () => {
      const encoder = new TextEncoder();
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('test\n'));
          controller.close();
        }
      });

      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(mockStream);

      // Make getState throw an error (container is dead)
      (sandbox as any).getState = vi.fn().mockRejectedValue(new Error('Container not found'));

      const stream = await sandbox.execStream('echo test');
      const reader = stream.getReader();

      // Read should still work since we're testing the health check error handling
      // The health check runs in background and shouldn't block reads initially
      const result = await reader.read();
      expect(result.done).toBe(false);
    });

    it('should work with all streaming APIs', async () => {
      const encoder = new TextEncoder();
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('test\n'));
          controller.close();
        }
      });

      // Test execStream
      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(mockStream);
      const execStream = await sandbox.execStream('echo test');
      expect(execStream).toBeInstanceOf(ReadableStream);

      // Test streamProcessLogs
      vi.spyOn(sandbox.client.processes, 'streamProcessLogs').mockResolvedValue(mockStream);
      const logsStream = await sandbox.streamProcessLogs('proc-1');
      expect(logsStream).toBeInstanceOf(ReadableStream);
    });
  });
});
