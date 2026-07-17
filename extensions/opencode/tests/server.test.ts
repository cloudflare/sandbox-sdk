import type { ProcessStatus } from '@repo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '../../../packages/sandbox/src/sandbox';
import {
  createOpenCodeServer,
  proxyToOpenCode,
  proxyToOpenCodeServer
} from '../src/opencode';
import type { OpenCodeServer } from '../src/types';

/** Minimal mock for SandboxProcess methods used by OpenCode integration */
interface MockProcess {
  id: string;
  command: readonly [string, ...string[]];
  startTime: Date;
  exitCode: Promise<number>;
  waitForPort: ReturnType<typeof vi.fn>;
  waitForExit: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  waitForLog: ReturnType<typeof vi.fn>;
}

/** Minimal mock for Sandbox methods used by OpenCode integration. */
interface MockSandbox {
  exec: ReturnType<typeof vi.fn>;
  getProcess: ReturnType<typeof vi.fn>;
  listProcesses: ReturnType<typeof vi.fn>;
  containerFetch: ReturnType<typeof vi.fn>;
}

function createProcessStatus(
  state: ProcessStatus['state'],
  overrides: Partial<MockProcess> = {}
): ProcessStatus {
  const base = {
    id: overrides.id ?? 'proc-1',
    pid: 123,
    command:
      overrides.command ??
      ([
        'opencode',
        'serve',
        '--port',
        '4096',
        '--hostname',
        '0.0.0.0'
      ] as const),
    startedAt: new Date().toISOString()
  };
  if (state === 'exited') {
    return {
      ...base,
      state,
      exit: { code: 0, timedOut: false },
      endedAt: new Date().toISOString()
    };
  }
  if (state === 'error') {
    return {
      ...base,
      state,
      error: { code: 'ERROR', message: 'failed' },
      endedAt: new Date().toISOString()
    };
  }
  return { ...base, state };
}

function createMockProcess(
  overrides: Partial<Omit<MockProcess, 'status'>> & {
    state?: ProcessStatus['state'];
  } = {}
): MockProcess {
  const { state: initialStatus = 'running', ...rest } = overrides;
  return {
    id: 'proc-1',
    command: ['opencode', 'serve', '--port', '4096', '--hostname', '0.0.0.0'],
    startTime: new Date(),
    exitCode: Promise.resolve(0),
    waitForPort: vi.fn().mockResolvedValue(undefined),
    waitForExit: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    logs: vi.fn().mockImplementation(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          }
        })
    ),
    status: vi.fn().mockResolvedValue(createProcessStatus(initialStatus, rest)),
    waitForLog: vi.fn().mockResolvedValue({ line: '' }),
    ...rest
  };
}

function createMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    exec: vi.fn(),
    getProcess: vi.fn().mockResolvedValue(null),
    listProcesses: vi.fn().mockResolvedValue([]),
    containerFetch: vi.fn().mockResolvedValue(new Response('ok')),
    ...overrides
  };
}

describe('createOpenCodeServer', () => {
  let mockSandbox: MockSandbox;
  let mockProcess: MockProcess;

  beforeEach(() => {
    mockProcess = createMockProcess();
    mockSandbox = createMockSandbox({
      // `sandbox.exec(cmd, opts)` returns a `SandboxProcessPromise` that
      // resolves to a `SandboxProcess`. Since the opencode code awaits it
      // and uses the result, a Promise resolving to our mock handle is
      // structurally sufficient.
      exec: vi.fn().mockResolvedValue(mockProcess)
    });
  });

  it('should start OpenCode server on default port 4096', async () => {
    const result = await createOpenCodeServer(
      mockSandbox as unknown as Sandbox
    );

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      ['opencode', 'serve', '--port', '4096', '--hostname', '0.0.0.0'],
      expect.any(Object)
    );
    expect(result.port).toBe(4096);
    expect(result.url).toBe('http://localhost:4096');
  });

  it('should start OpenCode server on custom port', async () => {
    const result = await createOpenCodeServer(
      mockSandbox as unknown as Sandbox,
      {
        port: 8080
      }
    );

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      ['opencode', 'serve', '--port', '8080', '--hostname', '0.0.0.0'],
      expect.any(Object)
    );
    expect(result.port).toBe(8080);
  });

  it('should start OpenCode server in specified directory', async () => {
    await createOpenCodeServer(mockSandbox as unknown as Sandbox, {
      directory: '/home/user/project'
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      ['opencode', 'serve', '--port', '4096', '--hostname', '0.0.0.0'],
      expect.objectContaining({ cwd: '/home/user/project' })
    );
  });

  it('passes the directory as cwd instead of shell text', async () => {
    await createOpenCodeServer(mockSandbox as unknown as Sandbox, {
      directory: '/tmp; rm -rf /'
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      ['opencode', 'serve', '--port', '4096', '--hostname', '0.0.0.0'],
      expect.objectContaining({ cwd: '/tmp; rm -rf /' })
    );
  });

  it('should pass config via OPENCODE_CONFIG_CONTENT env var', async () => {
    const config = {
      provider: { anthropic: { options: { apiKey: 'test-key' } } }
    };
    await createOpenCodeServer(mockSandbox as unknown as Sandbox, { config });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(Array),
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
    await createOpenCodeServer(mockSandbox as unknown as Sandbox, { config });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          ANTHROPIC_API_KEY: 'anthropic-key',
          OPENAI_API_KEY: 'openai-key'
        })
      })
    );
  });

  it('should pass custom env vars to the process', async () => {
    await createOpenCodeServer(mockSandbox as unknown as Sandbox, {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        TRACEPARENT: '00-abc123-def456-01'
      }
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
          TRACEPARENT: '00-abc123-def456-01'
        })
      })
    );
  });

  it('should allow custom env vars to override config-extracted env vars', async () => {
    const config = {
      provider: {
        anthropic: { options: { apiKey: 'config-key' } }
      }
    };
    await createOpenCodeServer(mockSandbox as unknown as Sandbox, {
      config,
      env: {
        ANTHROPIC_API_KEY: 'custom-override-key'
      }
    });

    expect(mockSandbox.exec).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: 'custom-override-key'
        })
      })
    );
  });

  it('should wait for port to be ready', async () => {
    await createOpenCodeServer(mockSandbox as unknown as Sandbox);

    expect(mockProcess.waitForPort).toHaveBeenCalledWith(4096, {
      mode: 'http',
      path: '/path',
      status: 200,
      timeout: 180_000
    });
  });

  it('should return server metadata', async () => {
    const result = await createOpenCodeServer(
      mockSandbox as unknown as Sandbox
    );

    expect(result.port).toBe(4096);
    expect(result.url).toBe('http://localhost:4096');
  });

  it('should provide close method that kills process', async () => {
    const result = await createOpenCodeServer(
      mockSandbox as unknown as Sandbox
    );

    await result.close();

    expect(mockProcess.kill).toHaveBeenCalledWith(15);
  });

  it('should throw OpenCodeStartupError when server fails to start', async () => {
    mockProcess.waitForPort.mockRejectedValue(new Error('timeout'));
    mockProcess.logs.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: 'stderr',
            data: new TextEncoder().encode('Server crashed')
          });
          controller.close();
        }
      })
    );

    await expect(
      createOpenCodeServer(mockSandbox as unknown as Sandbox)
    ).rejects.toThrow(/Server crashed/);
  });

  describe('process reuse', () => {
    it('should reuse existing running process on same port', async () => {
      const existingProcess = createMockProcess({
        command: [
          'opencode',
          'serve',
          '--port',
          '4096',
          '--hostname',
          '0.0.0.0'
        ]
      });
      mockSandbox.listProcesses.mockResolvedValue([
        createProcessStatus('running')
      ]);
      mockSandbox.getProcess.mockResolvedValue(existingProcess);

      const result = await createOpenCodeServer(
        mockSandbox as unknown as Sandbox
      );

      expect(mockSandbox.listProcesses).toHaveBeenCalledWith();
      expect(mockSandbox.getProcess).toHaveBeenCalledWith('proc-1');
      // Should not start a new process
      expect(mockSandbox.exec).not.toHaveBeenCalled();
      // Server should be valid (process is internal, not exposed)
      expect(result.port).toBe(4096);
    });

    it('should start new process when existing one has completed', async () => {
      mockSandbox.listProcesses.mockResolvedValue([
        createProcessStatus('exited')
      ]);

      await createOpenCodeServer(mockSandbox as unknown as Sandbox);

      // Should start a new process since existing one completed
      expect(mockSandbox.exec).toHaveBeenCalled();
    });

    it('should start new process on different port', async () => {
      mockSandbox.listProcesses.mockResolvedValue([]);

      await createOpenCodeServer(mockSandbox as unknown as Sandbox, {
        port: 8080
      });

      expect(mockSandbox.listProcesses).toHaveBeenCalledWith();
      // Should start new process on different port
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        ['opencode', 'serve', '--port', '8080', '--hostname', '0.0.0.0'],
        expect.any(Object)
      );
    });

    it('throws OpenCodeStartupError when a new process fails to become ready', async () => {
      mockProcess.waitForPort.mockRejectedValue(new Error('timeout'));
      mockProcess.logs.mockResolvedValue(
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'stderr',
              data: new TextEncoder().encode('Startup failed')
            });
            controller.close();
          }
        })
      );

      await expect(
        createOpenCodeServer(mockSandbox as unknown as Sandbox)
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
      await createOpenCodeServer(mockSandbox as unknown as Sandbox, {
        config: config as never
      });

      // Should start process without extracting invalid API keys
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
          })
        })
      );
      // Should NOT have any *_API_KEY env vars from malformed config
      const callArgs = mockSandbox.exec.mock.calls[0][1];
      const envKeys = Object.keys(callArgs.env);
      expect(envKeys.filter((k: string) => k.endsWith('_API_KEY'))).toEqual([]);
    });
  });
});

describe('proxyToOpenCodeServer', () => {
  const server: OpenCodeServer = {
    port: 4096,
    url: 'http://localhost:4096',
    close: vi.fn()
  };

  function createMockSandboxForProxy() {
    return {
      containerFetch: vi.fn().mockResolvedValue(new Response('proxied'))
    } as unknown as Sandbox;
  }

  it('should proxy GET requests directly without redirect', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/', {
      headers: { accept: 'text/html' }
    });

    await proxyToOpenCodeServer(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy POST requests directly', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/session', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test' })
    });

    await proxyToOpenCodeServer(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });
});

describe('proxyToOpenCode', () => {
  const server: OpenCodeServer = {
    port: 4096,
    url: 'http://localhost:4096',
    close: vi.fn()
  };

  function createMockSandboxForProxy() {
    return {
      containerFetch: vi.fn().mockResolvedValue(new Response('proxied'))
    } as unknown as Sandbox;
  }

  it('should redirect GET html requests to add ?url= parameter', () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/', {
      headers: { accept: 'text/html' }
    });

    const response = proxyToOpenCode(request, sandbox, server);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get('location')).toBe(
      'http://example.com/?url=http%3A%2F%2Fexample.com'
    );
  });

  it('should proxy POST requests directly without redirect', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/session', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test' })
    });

    await proxyToOpenCode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy GET requests that already have ?url= parameter', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/?url=http://example.com', {
      headers: { accept: 'text/html' }
    });

    await proxyToOpenCode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should proxy GET requests for non-html assets', async () => {
    const sandbox = createMockSandboxForProxy();
    const request = new Request('http://example.com/app.js', {
      headers: { accept: 'application/javascript' }
    });

    await proxyToOpenCode(request, sandbox, server);

    expect(sandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
  });
});
