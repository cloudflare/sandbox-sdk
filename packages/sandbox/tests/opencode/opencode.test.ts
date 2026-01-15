// packages/sandbox/tests/opencode/opencode.test.ts
import type { Process, ProcessStatus } from '@repo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpencode, proxyToOpencode } from '../../src/opencode/opencode';
import type { OpencodeServer } from '../../src/opencode/types';
import type { Sandbox } from '../../src/sandbox';

// Mock the dynamic import of @opencode-ai/sdk
vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({ session: {} })
}));

/** Minimal mock for Process methods used by OpenCode integration */
interface MockProcess {
  id: string;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  waitForPort: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  waitForLog: ReturnType<typeof vi.fn>;
}

/** Minimal mock for Sandbox methods used by OpenCode integration */
interface MockSandbox {
  startProcess: ReturnType<typeof vi.fn>;
  listProcesses: ReturnType<typeof vi.fn>;
  containerFetch: ReturnType<typeof vi.fn>;
}

function createMockProcess(overrides: Partial<MockProcess> = {}): MockProcess {
  return {
    id: 'proc-1',
    command: 'opencode serve --port 4096 --hostname 0.0.0.0',
    status: 'running',
    startTime: new Date(),
    waitForPort: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    getStatus: vi.fn().mockResolvedValue('running'),
    waitForLog: vi.fn().mockResolvedValue({ line: '' }),
    ...overrides
  };
}

function createMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    startProcess: vi.fn(),
    listProcesses: vi.fn().mockResolvedValue([]),
    containerFetch: vi.fn().mockResolvedValue(new Response('ok')),
    ...overrides
  };
}

describe('createOpencode', () => {
  let mockSandbox: MockSandbox;
  let mockProcess: MockProcess;

  beforeEach(() => {
    mockProcess = createMockProcess();
    mockSandbox = createMockSandbox({
      startProcess: vi.fn().mockResolvedValue(mockProcess)
    });
  });

  it('should start OpenCode server on default port 4096', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox);

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      'opencode serve --port 4096 --hostname 0.0.0.0',
      expect.any(Object)
    );
    expect(result.server.port).toBe(4096);
    expect(result.server.url).toBe('http://localhost:4096');
  });

  it('should start OpenCode server on custom port', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox, {
      port: 8080
    });

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      'opencode serve --port 8080 --hostname 0.0.0.0',
      expect.any(Object)
    );
    expect(result.server.port).toBe(8080);
  });

  it('should start OpenCode server in specified directory', async () => {
    await createOpencode(mockSandbox as unknown as Sandbox, {
      directory: '/home/user/project'
    });

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      'cd /home/user/project && opencode serve --port 4096 --hostname 0.0.0.0',
      expect.any(Object)
    );
  });

  it('should pass config via OPENCODE_CONFIG_CONTENT env var', async () => {
    const config = {
      provider: { anthropic: { options: { apiKey: 'test-key' } } }
    };
    await createOpencode(mockSandbox as unknown as Sandbox, { config });

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
        })
      })
    );
  });

  it('should extract API keys from config to env vars', async () => {
    const config = {
      provider: {
        anthropic: { options: { apiKey: 'anthropic-key' } },
        openai: { options: { apiKey: 'openai-key' } }
      }
    };
    await createOpencode(mockSandbox as unknown as Sandbox, { config });

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          ANTHROPIC_API_KEY: 'anthropic-key',
          OPENAI_API_KEY: 'openai-key'
        })
      })
    );
  });

  it('should wait for port to be ready', async () => {
    await createOpencode(mockSandbox as unknown as Sandbox);

    expect(mockProcess.waitForPort).toHaveBeenCalledWith(4096, {
      mode: 'http',
      path: '/',
      timeout: 60_000
    });
  });

  it('should return client and server', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox);

    expect(result.client).toBeDefined();
    expect(result.server).toBeDefined();
    expect(result.server.port).toBe(4096);
    expect(result.server.url).toBe('http://localhost:4096');
  });

  it('should provide close method that kills process', async () => {
    const result = await createOpencode(mockSandbox as unknown as Sandbox);

    await result.server.close();

    expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should throw OpencodeStartupError when server fails to start', async () => {
    mockProcess.waitForPort.mockRejectedValue(new Error('timeout'));
    mockProcess.getLogs.mockResolvedValue({
      stdout: '',
      stderr: 'Server crashed'
    });

    await expect(
      createOpencode(mockSandbox as unknown as Sandbox)
    ).rejects.toThrow(/Server crashed/);
  });

  describe('process reuse', () => {
    it('should reuse existing running process on same port', async () => {
      const existingProcess = createMockProcess({
        command: 'opencode serve --port 4096 --hostname 0.0.0.0',
        status: 'running'
      });
      mockSandbox.listProcesses.mockResolvedValue([existingProcess]);

      const result = await createOpencode(mockSandbox as unknown as Sandbox);

      // Should not start a new process
      expect(mockSandbox.startProcess).not.toHaveBeenCalled();
      // Server should be valid (process is internal, not exposed)
      expect(result.server.port).toBe(4096);
    });

    it('should wait for starting process to be ready', async () => {
      const startingProcess = createMockProcess({
        command: 'opencode serve --port 4096 --hostname 0.0.0.0',
        status: 'starting'
      });
      mockSandbox.listProcesses.mockResolvedValue([startingProcess]);

      await createOpencode(mockSandbox as unknown as Sandbox);

      // Should not start a new process
      expect(mockSandbox.startProcess).not.toHaveBeenCalled();
      // Should wait for the existing process
      expect(startingProcess.waitForPort).toHaveBeenCalledWith(4096, {
        mode: 'http',
        path: '/',
        timeout: 60_000
      });
    });

    it('should start new process when existing one has completed', async () => {
      const completedProcess = createMockProcess({
        command: 'opencode serve --port 4096 --hostname 0.0.0.0',
        status: 'completed'
      });
      mockSandbox.listProcesses.mockResolvedValue([completedProcess]);

      await createOpencode(mockSandbox as unknown as Sandbox);

      // Should start a new process since existing one completed
      expect(mockSandbox.startProcess).toHaveBeenCalled();
    });

    it('should start new process on different port', async () => {
      const existingProcess = createMockProcess({
        command: 'opencode serve --port 4096 --hostname 0.0.0.0',
        status: 'running'
      });
      mockSandbox.listProcesses.mockResolvedValue([existingProcess]);

      await createOpencode(mockSandbox as unknown as Sandbox, { port: 8080 });

      // Should start new process on different port
      expect(mockSandbox.startProcess).toHaveBeenCalledWith(
        'opencode serve --port 8080 --hostname 0.0.0.0',
        expect.any(Object)
      );
    });

    it('should throw OpencodeStartupError when starting process fails to become ready', async () => {
      const startingProcess = createMockProcess({
        command: 'opencode serve --port 4096 --hostname 0.0.0.0',
        status: 'starting'
      });
      startingProcess.waitForPort.mockRejectedValue(new Error('timeout'));
      startingProcess.getLogs.mockResolvedValue({
        stdout: '',
        stderr: 'Startup failed'
      });
      mockSandbox.listProcesses.mockResolvedValue([startingProcess]);

      await expect(
        createOpencode(mockSandbox as unknown as Sandbox)
      ).rejects.toThrow(/Startup failed/);
    });
  });

  describe('malformed config handling', () => {
    it.each([
      ['string', { provider: 'anthropic' }],
      ['array', { provider: ['anthropic'] }],
      ['null', { provider: null }],
      ['number', { provider: 42 }]
    ])('should handle provider as %s without crashing', async (_, config) => {
      await createOpencode(mockSandbox as unknown as Sandbox, {
        config: config as never
      });

      // Should start process without extracting invalid API keys
      expect(mockSandbox.startProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          env: expect.objectContaining({
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
          })
        })
      );
      // Should NOT have any *_API_KEY env vars from malformed config
      const callArgs = mockSandbox.startProcess.mock.calls[0][1];
      const envKeys = Object.keys(callArgs.env);
      expect(envKeys.filter((k: string) => k.endsWith('_API_KEY'))).toEqual([]);
    });
  });
});

describe('proxyToOpencode', () => {
  const server: OpencodeServer = {
    port: 4096,
    url: 'http://localhost:4096',
    close: vi.fn()
  };

  function createMockSandboxForProxy() {
    return {
      containerFetch: vi.fn().mockResolvedValue(new Response('proxied'))
    } as unknown as Sandbox;
  }

  it('should redirect GET html requests to add ?url= parameter', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/', {
      headers: { accept: 'text/html' }
    });

    const response = await proxyToOpencode(request, sandbox, server);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'http://example.com/?url=http%3A%2F%2Fexample.com'
    );
  });

  it('should proxy POST requests directly without redirect', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/session', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test' })
    });

    await proxyToOpencode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy GET requests that already have ?url= parameter', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/?url=http://example.com', {
      headers: { accept: 'text/html' }
    });

    await proxyToOpencode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy GET requests for non-html assets', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/app.js', {
      headers: { accept: 'application/javascript' }
    });

    await proxyToOpencode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });
});
