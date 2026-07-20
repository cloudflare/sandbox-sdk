import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext, JsonRpcMessage } from './rpc';

// Avoid passing options object to vi.mock virtual call
vi.mock('cloudflare:workers', () => {
  return {
    DurableObject: class {},
    RpcTarget: class {},
    WorkerEntrypoint: class {},
    DurableObjectState: class {}
  };
});

interface ExecCall {
  argv: string[];
  options?: Record<string, unknown>;
}

interface GitCheckoutCall {
  repoUrl: string;
  options?: Record<string, unknown>;
}

interface WriteFileCall {
  path: string;
  content: string;
}

interface MockProcessStatus {
  id: string;
  command: string[];
  state: 'running' | 'exited' | 'error';
  pid: number;
}

interface PortWatchEvent {
  type: 'ready' | 'error';
}

const mockExecCalls: ExecCall[] = [];
let mockGitCheckoutCall: GitCheckoutCall | null = null;
const mockWriteFileCalls: WriteFileCall[] = [];
const mockReadFileCalls: Record<string, string> = {};
const mockListProcessesCalls: MockProcessStatus[] = [];
const mockEvents: string[] = [];

// Create a mock durable object state & env
const mockCtx = {
  storage: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
} as unknown as DurableObjectState<{}>;

const mockEnv = {
  OPENAI_API_KEY: 'test-api-key',
  AUTH_TOKEN: 'test-token'
} as unknown as Env;

// Standard mocks
vi.mock('@cloudflare/sandbox', () => {
  return {
    getSandbox: vi.fn().mockImplementation((_ns: unknown, id: string) => {
      const s = {
        id,
        gitCheckout: async (
          repoUrl: string,
          options?: Record<string, unknown>
        ) => {
          mockEvents.push('checkout:start');
          mockGitCheckoutCall = { repoUrl, options };
          mockEvents.push('checkout:end');
          return { ok: true };
        },
        exec: async (argv: string[], options?: Record<string, unknown>) => {
          mockEvents.push(`exec:start:${argv.join(' ')}`);
          mockExecCalls.push({ argv, options });
          mockEvents.push(`exec:end:${argv.join(' ')}`);
          return {
            id: 'proc-spawned',
            waitForExit: async () => {
              mockEvents.push(`exec:exit:${argv.join(' ')}`);
            },
            waitForPort: async () => {},
            output: async () => {
              if (argv.join(' ').includes('nc -z')) {
                return { exitCode: 1, stdout: '', stderr: '' };
              }
              return { exitCode: 0, stdout: 'success', stderr: '' };
            }
          };
        },
        writeFile: async (path: string, content: string) => {
          mockWriteFileCalls.push({ path, content });
        },
        readFile: async (path: string) => {
          return { content: mockReadFileCalls[path] || '' };
        },
        listProcesses: async () => {
          return mockListProcessesCalls;
        },
        setEnvVars: async () => {},
        destroy: vi.fn()
      };
      return s;
    }),
    Sandbox: class {
      gitCheckout = vi.fn();
    },
    proxyToSandbox: vi.fn().mockResolvedValue(null)
  };
});

import { Sandbox } from './index';

describe('Codex App-Server Setup & Admission', () => {
  beforeEach(() => {
    mockExecCalls.length = 0;
    mockGitCheckoutCall = null;
    mockWriteFileCalls.length = 0;
    mockEvents.length = 0;
    mockListProcessesCalls.length = 0;
    Object.keys(mockReadFileCalls).forEach((k) => {
      delete mockReadFileCalls[k];
    });
  });

  const setupMockPorts = (sandbox: Sandbox, events: PortWatchEvent[]) => {
    const sMock = sandbox as unknown as {
      client: {
        ports: {
          openWatch: (port: number) => Promise<{
            stream: () => Promise<{
              getReader: () => {
                read: () => Promise<{
                  value: PortWatchEvent | null;
                  done: boolean;
                }>;
                cancel: () => Promise<void>;
              };
            }>;
            [Symbol.dispose]?: () => void;
          }>;
        };
      };
    };

    sMock.client = {
      ports: {
        openWatch: async (_port: number) => {
          return {
            stream: async () => {
              return {
                getReader: () => {
                  let callCount = 0;
                  return {
                    read: async () => {
                      callCount++;
                      if (events?.[callCount - 1]) {
                        return { value: events[callCount - 1], done: false };
                      }
                      return { value: null, done: true };
                    },
                    cancel: async () => {}
                  };
                }
              };
            },
            [Symbol.dispose]: () => {}
          };
        }
      }
    };
  };

  it('verifies single-flighting of concurrent app server admissions', async () => {
    const sandbox = new Sandbox(mockCtx, mockEnv);
    setupMockPorts(sandbox, [{ type: 'ready' }]);

    const sMock = sandbox as unknown as {
      listProcesses: () => Promise<MockProcessStatus[]>;
      readFile: (path: string) => Promise<{ content: string }>;
      writeFile: (path: string, content: string) => Promise<void>;
      setEnvVars: (vars: Record<string, string>) => Promise<void>;
      exec: (argv: string[]) => Promise<{ id: string }>;
    };

    sMock.listProcesses = async () => mockListProcessesCalls;
    sMock.readFile = async (path: string) => ({
      content: mockReadFileCalls[path] || ''
    });
    sMock.writeFile = async (path: string, content: string) => {
      mockWriteFileCalls.push({ path, content });
      mockReadFileCalls[path] = content;
    };
    sMock.setEnvVars = async () => {};
    sMock.exec = async (argv: string[]) => {
      mockExecCalls.push({ argv });
      return { id: 'proc-spawned' };
    };

    const [first, second] = await Promise.all([
      sandbox.ensureCodexAppServer(),
      sandbox.ensureCodexAppServer()
    ]);

    expect(first).toEqual(second);
    expect(
      mockExecCalls.filter((c) => c.argv.join(' ').includes('codex app-server'))
    ).toHaveLength(1);
    expect(mockWriteFileCalls).toHaveLength(1);
    expect(first.token).toBeTruthy();
  });

  it('verifies exact running process recovery', async () => {
    const sandbox = new Sandbox(mockCtx, mockEnv);
    setupMockPorts(sandbox, [{ type: 'ready' }]);

    const sMock = sandbox as unknown as {
      listProcesses: () => Promise<MockProcessStatus[]>;
      readFile: (path: string) => Promise<{ content: string }>;
      writeFile: ReturnType<typeof vi.fn>;
      exec: ReturnType<typeof vi.fn>;
    };

    sMock.listProcesses = async () => [
      {
        id: 'proc_123',
        command: [
          '/bin/bash',
          '-lc',
          'codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /tmp/codex-ws-token'
        ],
        state: 'running',
        pid: 123
      }
    ];

    mockReadFileCalls['/tmp/codex-ws-token'] = 'valid-recovered-token';

    sMock.readFile = async (path: string) => ({
      content: mockReadFileCalls[path] || ''
    });
    sMock.writeFile = vi.fn();
    sMock.exec = vi.fn();

    const recovered = await sandbox.ensureCodexAppServer();
    expect(recovered.token).toBe('valid-recovered-token');
    expect(recovered.processId).toBe('proc_123');
    expect(sMock.exec).not.toHaveBeenCalled();
    expect(sMock.writeFile).not.toHaveBeenCalled();
  });

  it('rejects substring false matches during recovery', async () => {
    const sandbox = new Sandbox(mockCtx, mockEnv);
    setupMockPorts(sandbox, [{ type: 'ready' }]);

    const sMock = sandbox as unknown as {
      listProcesses: () => Promise<MockProcessStatus[]>;
      readFile: (path: string) => Promise<{ content: string }>;
      writeFile: (path: string, content: string) => Promise<void>;
      setEnvVars: (vars: Record<string, string>) => Promise<void>;
      exec: (argv: string[]) => Promise<{ id: string }>;
    };

    // Matches codex app-server substring but NOT exact argv array
    sMock.listProcesses = async () => [
      {
        id: 'proc_123',
        command: [
          '/bin/bash',
          '-lc',
          'echo "codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /tmp/codex-ws-token"'
        ],
        state: 'running',
        pid: 123
      }
    ];

    sMock.readFile = async (path: string) => ({
      content: mockReadFileCalls[path] || ''
    });
    sMock.writeFile = async (path: string, content: string) => {
      mockWriteFileCalls.push({ path, content });
      mockReadFileCalls[path] = content;
    };
    sMock.setEnvVars = async () => {};
    sMock.exec = async (argv: string[]) => {
      mockExecCalls.push({ argv });
      return { id: 'proc-spawned' };
    };

    const admission = await sandbox.ensureCodexAppServer();
    expect(admission.processId).toBe('proc-spawned');
    expect(admission.token).not.toBe('valid-recovered-token');
    expect(mockExecCalls).toHaveLength(1);
    expect(mockExecCalls[0].argv).toEqual([
      '/bin/bash',
      '-lc',
      'codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /tmp/codex-ws-token'
    ]);
  });

  it('rejects recovery if the recovered token file is empty', async () => {
    const sandbox = new Sandbox(mockCtx, mockEnv);
    setupMockPorts(sandbox, [{ type: 'ready' }]);

    const sMock = sandbox as unknown as {
      listProcesses: () => Promise<MockProcessStatus[]>;
      readFile: (path: string) => Promise<{ content: string }>;
      writeFile: (path: string, content: string) => Promise<void>;
      setEnvVars: (vars: Record<string, string>) => Promise<void>;
      exec: (argv: string[]) => Promise<{ id: string }>;
    };

    sMock.listProcesses = async () => [
      {
        id: 'proc_123',
        command: [
          '/bin/bash',
          '-lc',
          'codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /tmp/codex-ws-token'
        ],
        state: 'running',
        pid: 123
      }
    ];

    mockReadFileCalls['/tmp/codex-ws-token'] = '   '; // empty/whitespaces

    sMock.readFile = async (path: string) => ({
      content: mockReadFileCalls[path] || ''
    });
    sMock.writeFile = async (path: string, content: string) => {
      mockWriteFileCalls.push({ path, content });
      mockReadFileCalls[path] = content;
    };
    sMock.setEnvVars = async () => {};
    sMock.exec = async (argv: string[]) => {
      mockExecCalls.push({ argv });
      return { id: 'proc-spawned' };
    };

    const admission = await sandbox.ensureCodexAppServer();
    expect(admission.processId).toBe('proc-spawned');
    expect(admission.token).not.toBe('   ');
    expect(mockExecCalls).toHaveLength(1);
  });

  it('clears in-flight promise and permits retries on failure', async () => {
    const sandbox = new Sandbox(mockCtx, mockEnv);
    setupMockPorts(sandbox, [{ type: 'ready' }]);

    const sMock = sandbox as unknown as {
      listProcesses: () => Promise<MockProcessStatus[]>;
      readFile: (path: string) => Promise<{ content: string }>;
      writeFile: (path: string, content: string) => Promise<void>;
      setEnvVars: (vars: Record<string, string>) => Promise<void>;
      exec: (argv: string[]) => Promise<{ id: string }>;
    };

    sMock.listProcesses = async () => [];
    sMock.readFile = async (_path: string) => ({ content: '' });
    sMock.writeFile = async (_path: string, _content: string) => {};
    sMock.setEnvVars = async (_vars: Record<string, string>) => {};

    sMock.exec = async (_argv: string[]) => {
      throw new Error('Launch failed');
    };

    await expect(sandbox.ensureCodexAppServer()).rejects.toThrow(
      'Launch failed'
    );

    // Restore functioning exec and verify we can retry successfully
    sMock.exec = async (argv: string[]) => {
      mockExecCalls.push({ argv });
      return { id: 'proc-spawned' };
    };

    const secondTry = await sandbox.ensureCodexAppServer();
    expect(secondTry.processId).toBe('proc-spawned');
    expect(mockExecCalls).toHaveLength(1);
  });

  it('waitForPortReady delegates to admitted public port readiness', async () => {
    const sandbox = new Sandbox(mockCtx, mockEnv);
    const startAndWaitForPorts = vi.fn(async (_port: number) => undefined);
    Object.assign(sandbox, { startAndWaitForPorts });

    await expect(sandbox.waitForPortReady(4500)).resolves.toBeUndefined();
    expect(startAndWaitForPorts).toHaveBeenCalledWith(4500);

    startAndWaitForPorts.mockRejectedValueOnce(new Error('Port unavailable'));
    await expect(sandbox.waitForPortReady(4500)).rejects.toThrow(
      'Port unavailable'
    );
  });

  it('verifies workspace cleanup waits for exit before gitCheckout starts', async () => {
    const cloudflareSandboxModule = await import('@cloudflare/sandbox');
    const sandbox = cloudflareSandboxModule.getSandbox(
      {} as unknown as Env['Sandbox'],
      'test-sandbox'
    );

    const sMock = sandbox as unknown as {
      gitCheckout: (
        repoUrl: string,
        options?: Record<string, unknown>
      ) => Promise<{ ok: boolean }>;
    };

    // Inject custom gitCheckout to trace events order
    let checkoutBeforeCleanupExit = false;
    const originalGit = sMock.gitCheckout;
    sMock.gitCheckout = async (
      repoUrl: string,
      options?: Record<string, unknown>
    ) => {
      const exitIndex = mockEvents.findIndex(
        (e) => e.startsWith('exec:exit:') && e.includes('find /workspace')
      );
      if (exitIndex === -1) {
        checkoutBeforeCleanupExit = true;
      }
      return originalGit(repoUrl, options);
    };

    const indexModule = await import('./index');
    const handler = indexModule.sandboxSetup(sandbox);
    const msg = {
      id: 1,
      jsonrpc: '2.0',
      method: 'sandbox/setup',
      params: { repoUrl: 'https://github.com/user/repo' }
    } as unknown as JsonRpcMessage;

    interface HandlerContextMock {
      direction: 'client-to-server';
      sendToClient: ReturnType<typeof vi.fn>;
      sendToServer: ReturnType<typeof vi.fn>;
    }

    const ctx: HandlerContextMock = {
      direction: 'client-to-server',
      sendToClient: vi.fn(),
      sendToServer: vi.fn()
    };

    const result = handler(msg, ctx as unknown as HandlerContext);
    expect(result).toBeNull(); // handled asynchronously

    // Let the event loop drain to execute the async block
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ctx.sendToClient).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({ ok: true })
      })
    );
    expect(checkoutBeforeCleanupExit).toBe(false);
    const exitIndex = mockEvents.findIndex(
      (e) => e.startsWith('exec:exit:') && e.includes('find /workspace')
    );
    expect(exitIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeLessThan(mockEvents.indexOf('checkout:start'));
  });
});
