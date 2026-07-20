import { Container, getContainer } from '@cloudflare/containers';
import type * as SharedRoot from '@repo/shared';
import type { ISandbox, ProcessLogEvent, ProcessStatus } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerControlClient } from '../src/container-control';
import {
  ContainerUnavailableError,
  ErrorCode,
  InvalidBackupConfigError,
  PortNotExposedError,
  RPCTransportError,
  RuntimeControlProtocolError
} from '../src/errors';
import { SandboxExtension, type SandboxLike } from '../src/extensions';
import { RuntimeIdentityInactiveError } from '../src/runtime/types';
import { connect, getSandbox, Sandbox } from '../src/sandbox';
import {
  asSandboxWithClient,
  createMockControlClient
} from './helpers/mock-control-client';

const controlConnectionMockState = vi.hoisted(() => ({
  client: null as unknown,
  activated: false,
  lastConnection: null as { disconnect(): void } | null
}));

function processLogStream(
  events: ProcessLogEvent[]
): ReadableStream<ProcessLogEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    }
  });
}

vi.mock('../src/container-control/connection', () => ({
  ContainerControlConnection: class {
    onClose?: () => void;
    constructor(options?: { onClose?: () => void }) {
      this.onClose = options?.onClose;
      controlConnectionMockState.lastConnection = this;
    }
    isConnected() {
      return true;
    }
    getStats() {
      return { imports: 1, exports: 1 };
    }
    disconnect() {
      controlConnectionMockState.activated = false;
      this.onClose?.();
    }
    async connect() {}
    async getRuntimeMetadata() {
      return {
        runtimeIncarnationID: 'test-incarnation',
        sandboxVersion: '0.0.0',
        controlProtocolVersion: 1
      };
    }
    async activateControlSession(expectedRuntimeIncarnationID: string) {
      controlConnectionMockState.activated = true;
      return {
        runtimeIncarnationID: expectedRuntimeIncarnationID,
        sandboxVersion: '0.0.0',
        controlProtocolVersion: 1
      };
    }
    rpc() {
      if (!controlConnectionMockState.activated) {
        throw new Error('control session must be activated before rpc()');
      }
      return controlConnectionMockState.client;
    }
  }
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
    async startAndWaitForPorts(): Promise<void> {
      // No-op: real container startup is not needed in tests.
    }
    async destroy(): Promise<void> {
      // No-op: real container destroy is not needed in tests; individual
      // tests that want to simulate destroy behavior use vi.spyOn.
    }
    async stop(): Promise<void> {
      // No-op: real container stop is not needed in tests.
    }
    async getState() {
      // Mock implementation - return healthy state
      return { status: 'healthy' };
    }
    renewActivityTimeout() {
      // Mock implementation - reschedules activity timeout
    }
  };

  const MockContainerProxy = class ContainerProxy {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
      return new Response('Mock ContainerProxy fetch');
    }
  };

  return {
    Container: MockContainer,
    ContainerProxy: MockContainerProxy,
    getContainer: vi.fn(),
    switchPort: mockSwitchPort
  };
});

interface MockStorage {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
}

interface MockCtx {
  storage: MockStorage;
  blockConcurrencyWhile: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  container: {
    running: boolean;
    getTcpPort?: ReturnType<typeof vi.fn>;
    start?: ReturnType<typeof vi.fn>;
    exec?: ReturnType<typeof vi.fn>;
  };
  id: {
    toString: () => string;
    equals: ReturnType<typeof vi.fn>;
    name: string;
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeSocket extends EventTarget {
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.dispatchEvent(new Event('close'));
  }
}

const PREVIEW_TEST_PORT = 8080;
const PREVIEW_TEST_TOKEN = 'token12345678901';
const PREVIEW_TEST_RUNTIME_ID = 'runtime-1';

function runtimeRecord(id: string) {
  return {
    schemaVersion: 1,
    id,
    runtimeIncarnationID: 'test-incarnation'
  };
}

type PreviewRuntimeRunnerProbe = {
  runExisting<T>(
    target: unknown,
    operation: string,
    call: (lease: {
      runtime: unknown;
      retain(): { release(): void };
    }) => Promise<T>
  ): Promise<T | { status: 'absent' }>;
  runWaking<T>(
    operation: string,
    call: (lease: {
      runtime: unknown;
      retain(): { release(): void };
    }) => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<T>;
};

function getPreviewRuntimeRunner(sandbox: Sandbox): PreviewRuntimeRunnerProbe {
  return (sandbox as unknown as { runtimeRunner: PreviewRuntimeRunnerProbe })
    .runtimeRunner;
}

type PreviewRuntimeLifecycleProbe = {
  assertActive(runtime: unknown): Promise<void>;
};

function getPreviewRuntimeLifecycle(
  sandbox: Sandbox
): PreviewRuntimeLifecycleProbe {
  return (
    sandbox as unknown as { runtimeLifecycle: PreviewRuntimeLifecycleProbe }
  ).runtimeLifecycle;
}

function activePreviewStorageState({
  port = PREVIEW_TEST_PORT,
  token = PREVIEW_TEST_TOKEN,
  runtimeIdentityID = PREVIEW_TEST_RUNTIME_ID
}: {
  port?: number;
  token?: string;
  runtimeIdentityID?: string;
} = {}) {
  return {
    portTokens: {
      [port.toString()]: { token }
    },
    currentRuntimeIdentity: runtimeRecord(runtimeIdentityID),
    activePreviewPorts: {
      [port.toString()]: {
        runtimeIdentityID,
        runtimeIncarnationID: 'test-incarnation',
        token
      }
    }
  };
}

function mockPreviewStorageGet(
  mockCtx: MockCtx,
  state: Partial<ReturnType<typeof activePreviewStorageState>>
): void {
  vi.mocked(mockCtx.storage.get).mockImplementation(
    async (key) => state[key as keyof typeof state] ?? null
  );
}

function createPreviewProxyRequest(path = '/api'): Request {
  return new Request(
    `https://8080-test-sandbox-token12345678901.example.com${path}`,
    {
      headers: {
        'x-sandbox-preview-proxy': '1',
        'x-sandbox-preview-port': '8080',
        'x-sandbox-preview-token': 'token12345678901',
        'x-sandbox-preview-sandbox-id': 'test-sandbox'
      }
    }
  );
}

function createPreviewWebSocketRequest(): Request {
  return new Request(
    'https://8080-test-sandbox-token12345678901.example.com/ws',
    {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'test-key-123',
        'Sec-WebSocket-Version': '13',
        'x-sandbox-preview-proxy': '1',
        'x-sandbox-preview-port': '8080',
        'x-sandbox-preview-token': 'token12345678901',
        'x-sandbox-preview-sandbox-id': 'test-sandbox'
      }
    }
  );
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

function mockNativeProcess(stdout: string, stderr: string, exitCode: number) {
  return {
    stdin: null,
    stdout: textStream(stdout),
    stderr: textStream(stderr),
    pid: 123,
    exitCode: Promise.resolve(exitCode),
    output: async () => ({
      stdout: await new Response(textStream(stdout)).arrayBuffer(),
      stderr: await new Response(textStream(stderr)).arrayBuffer(),
      exitCode
    }),
    kill: vi.fn()
  };
}

function processOutputStream(result: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      if (result.stdout) {
        controller.enqueue({
          type: 'stdout',
          processId: 'mock-process-id',
          cursor: '1',
          timestamp: new Date().toISOString(),
          data: encoder.encode(result.stdout)
        });
      }
      if (result.stderr) {
        controller.enqueue({
          type: 'stderr',
          processId: 'mock-process-id',
          cursor: '2',
          timestamp: new Date().toISOString(),
          data: encoder.encode(result.stderr)
        });
      }
      controller.enqueue({
        type: 'terminal',
        processId: 'mock-process-id',
        cursor: '3',
        timestamp: new Date().toISOString(),
        exit: { code: result.exitCode, timedOut: false }
      });
      controller.close();
    }
  });
}

describe('Sandbox durable object behavior', () => {
  let sandbox: Sandbox;
  let mockCtx: MockCtx;
  let mockEnv: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const storageState = new Map<string, unknown>([
      [
        'currentRuntimeIdentity',
        {
          schemaVersion: 1,
          id: 'runtime-a',
          runtimeIncarnationID: 'test-incarnation'
        }
      ]
    ]);

    const storage = {
      get: vi.fn(async (key: string) => storageState.get(key) ?? null),
      put: vi.fn(async (key: string, value: unknown) => {
        storageState.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        storageState.delete(key);
      }),
      list: vi.fn().mockResolvedValue(new Map()),
      transaction: vi.fn(async (callback) => callback(storage))
    };

    // Mock DurableObjectState
    mockCtx = {
      storage: storage as any,
      blockConcurrencyWhile: vi
        .fn()
        .mockImplementation(
          <T>(callback: () => Promise<T>): Promise<T> => callback()
        ),
      waitUntil: vi.fn(),
      container: {
        running: true,
        getTcpPort: vi.fn(() => ({
          fetch: vi.fn(async () => new Response('Mock TCP port fetch'))
        })),
        start: vi.fn(),
        exec: vi.fn().mockImplementation(async () => {
          return {
            pid: 123,
            stdin: null,
            stdout: null,
            stderr: null,
            exitCode: Promise.resolve(0),
            output: () =>
              Promise.resolve({
                exitCode: 0,
                stdout: new TextEncoder().encode(''),
                stderr: new TextEncoder().encode('')
              }),
            kill: () => Promise.resolve()
          };
        })
      },
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox'
      } as any
    };

    mockEnv = {};

    // Create Sandbox instance - control client is created internally
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
    const sandboxWithClient = asSandboxWithClient(sandbox);
    sandboxWithClient.client = createMockControlClient();
    controlConnectionMockState.client = sandboxWithClient.client;
    controlConnectionMockState.activated = false;

    // Now spy on the client methods that we need for testing

    vi.spyOn(
      asSandboxWithClient(sandbox).client.files,
      'writeFile'
    ).mockResolvedValue({
      success: true,
      path: '/test.txt',
      timestamp: new Date().toISOString()
    } as any);

    vi.spyOn(
      asSandboxWithClient(sandbox).client.watch,
      'checkChanges'
    ).mockResolvedValue({
      success: true,
      status: 'unchanged',
      version: 'watch-1:0',
      timestamp: new Date().toISOString()
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extension dispatch', () => {
    class TestExtension extends SandboxExtension {
      readonly prefix: string;

      constructor(sandbox: SandboxLike, prefix: string) {
        super(sandbox);
        this.prefix = prefix;
      }

      run(input: string): string {
        return `${this.prefix}:${input}`;
      }
    }

    it('dispatches extension methods through the Worker-side nested proxy', async () => {
      const callExtension = vi.fn(
        async (extensionName: string, method: string, args: unknown[]) => ({
          extensionName,
          method,
          args
        })
      );
      const topLevelCall = vi.fn(async (...args: unknown[]) => ({ args }));
      vi.mocked(getContainer).mockReturnValue(
        new Proxy(
          { callExtension },
          {
            get: (target, prop) => {
              if (prop === 'callExtension') return target.callExtension;
              return topLevelCall;
            }
          }
        ) as unknown as ReturnType<typeof getContainer>
      );

      const proxied = getSandbox(
        {} as DurableObjectNamespace<Sandbox>,
        'extension-proxy-test'
      ) as unknown as {
        interpreter: { runCode(code: string): Promise<unknown> };
        topLevelMethod(value: string): Promise<unknown>;
      };
      topLevelCall.mockClear();

      await expect(proxied.interpreter.runCode('print(1)')).resolves.toEqual({
        extensionName: 'interpreter',
        method: 'runCode',
        args: ['print(1)']
      });
      expect(topLevelCall).not.toHaveBeenCalled();

      await expect(proxied.topLevelMethod('ok')).resolves.toEqual({
        args: ['ok']
      });
      expect(topLevelCall).toHaveBeenCalledWith('ok');
    });

    it('dispatches only real SandboxExtension instances inside the DO', async () => {
      Object.assign(sandbox, {
        testExtension: new TestExtension(
          sandbox as unknown as SandboxLike,
          'ran'
        ),
        notExtension: { run: () => 'nope' }
      });

      await expect(
        sandbox.callExtension('testExtension', 'run', ['ok'])
      ).resolves.toBe('ran:ok');
      await expect(
        sandbox.callExtension('notExtension', 'run', [])
      ).rejects.toThrow(/Unknown sandbox extension/);
      await expect(
        sandbox.callExtension('testExtension', 'missing', [])
      ).rejects.toThrow(/Unknown extension method/);
      await expect(
        sandbox.callExtension('testExtension', 'sidecar', [])
      ).rejects.toThrow(/Unknown extension method/);
    });
  });

  describe('RPC routing', () => {
    it('launches and returns a private process descriptor', async () => {
      const descriptor = await sandbox.exec(['echo', 'hello'], {
        cwd: '/workspace'
      });

      expect(
        asSandboxWithClient(sandbox).client.processes.start
      ).toHaveBeenCalledWith(['echo', 'hello'], { cwd: '/workspace' });
      expect(descriptor).toMatchObject({
        id: 'mock-process-id',
        pid: 123
      });
      expect(descriptor.capability.status).toBeTypeOf('function');
    });

    it('wakes, captures, and pre-validates before launch, then post-fences', async () => {
      const order: string[] = [];
      mockCtx.storage.get.mockImplementation(async (key: string) => {
        if (key === 'currentRuntimeIdentity') {
          order.push('runtime');
          return {
            schemaVersion: 1,
            id: 'runtime-a',
            runtimeIncarnationID: 'test-incarnation'
          };
        }
        return null;
      });
      vi.spyOn(
        asSandboxWithClient(sandbox).client.processes,
        'start'
      ).mockImplementation(async (command) => {
        order.push('start');
        return {
          id: 'p1',
          pid: 123,
          command,
          state: 'running',
          startedAt: new Date().toISOString()
        };
      });

      await sandbox.exec(['echo', 'ordered']);

      expect(order).toContain('runtime');
      expect(order).toContain('start');
      expect(order.indexOf('start')).toBeGreaterThan(order.indexOf('runtime'));
    });

    it('rejects a runtime replacement while launch RPC is pending', async () => {
      let resolveStart!: (status: ProcessStatus) => void;
      const pendingStart = new Promise<ProcessStatus>((resolve) => {
        resolveStart = resolve;
      });
      vi.spyOn(
        asSandboxWithClient(sandbox).client.processes,
        'start'
      ).mockReturnValueOnce(pendingStart);
      const launch = sandbox.exec(['sleep', '1']);
      launch.catch(() => undefined);
      await vi.waitFor(() =>
        expect(
          asSandboxWithClient(sandbox).client.processes.start
        ).toHaveBeenCalledOnce()
      );
      await (sandbox as any).runtimeLifecycle.invalidate();
      resolveStart({
        id: 'p1',
        pid: 123,
        command: ['sleep', '1'],
        state: 'running',
        startedAt: new Date().toISOString()
      });

      await expect(launch).rejects.toMatchObject({
        code: 'OPERATION_INTERRUPTED',
        context: { operation: 'process.start' }
      });
    });

    it('returns a descriptor for a retained terminal process', async () => {
      const status: ProcessStatus = {
        id: 'p1',
        pid: 123,
        command: ['/bin/true'],
        state: 'exited',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        exit: { code: 0, timedOut: false }
      };
      Object.assign(sandbox, {
        processLifecycle: {
          captureCurrent: vi.fn(async () => runtimeRecord('runtime-a')),
          runRead: vi.fn(async () => status)
        }
      });

      await expect(sandbox.getProcess('p1')).resolves.toMatchObject({
        id: 'p1',
        pid: 123
      });
    });

    it('returns process listings as data without N+1 status calls', async () => {
      const status: ProcessStatus = {
        id: 'p1',
        pid: 123,
        command: ['/bin/true'],
        state: 'running',
        startedAt: new Date().toISOString()
      };
      vi.mocked(
        asSandboxWithClient(sandbox).client.processes.list
      ).mockResolvedValueOnce([status]);

      await expect(sandbox.listProcesses()).resolves.toEqual([status]);
      expect(
        asSandboxWithClient(sandbox).client.processes.list
      ).toHaveBeenCalledTimes(1);
      expect(
        asSandboxWithClient(sandbox).client.processes.get
      ).not.toHaveBeenCalled();
    });

    it('rejects malformed JavaScript argv before process control', async () => {
      await expect(
        Reflect.apply(sandbox.exec, sandbox, ['echo hello'])
      ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
      await expect(
        Reflect.apply(sandbox.exec, sandbox, [[]])
      ).rejects.toMatchObject({
        code: 'INVALID_COMMAND'
      });
      await expect(sandbox.exec([''])).rejects.toMatchObject({
        code: 'INVALID_COMMAND'
      });
      await expect(
        Reflect.apply(sandbox.exec, sandbox, [[123]])
      ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
      expect(
        asSandboxWithClient(sandbox).client.processes.start
      ).not.toHaveBeenCalled();
    });

    it('logs launch identity without an exit code', async () => {
      const infoSpy = vi.spyOn((sandbox as any).logger, 'info');
      vi.spyOn(
        asSandboxWithClient(sandbox).client.processes,
        'start'
      ).mockResolvedValueOnce({
        id: 'logged-process',
        pid: 456,
        command: ['echo', 'test_logging'],
        state: 'exited',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        exit: { code: 42, timedOut: false }
      });

      const descriptor = await sandbox.exec(['echo', 'test_logging']);

      expect(descriptor.id).toBe('logged-process');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('sandbox.exec'),
        expect.not.objectContaining({ exitCode: expect.anything() })
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: 'sandbox.exec',
          outcome: 'success',
          command: 'echo test_logging',
          processId: 'logged-process',
          pid: 456
        })
      );

      infoSpy.mockRestore();
    });

    it('returns null for inactive discovery without starting the runtime', async () => {
      Object.assign(sandbox, {
        processLifecycle: {
          captureCurrent: vi.fn(async () => null)
        }
      });
      mockCtx.container.running = false;

      await expect(sandbox.getProcess('p1')).resolves.toBeNull();

      expect(mockCtx.container.start).not.toHaveBeenCalled();
      expect(
        asSandboxWithClient(sandbox).client.processes.get
      ).not.toHaveBeenCalled();
    });

    it('runs direct file operations through file RPC', async () => {
      await sandbox.writeFile('/test.txt', 'content');
      expect(
        asSandboxWithClient(sandbox).client.files.writeFile
      ).toHaveBeenCalledWith('/test.txt', 'content', { encoding: undefined });
    });

    it('owns public watch subscriptions after consuming data', async () => {
      const chunk = new TextEncoder().encode(
        'data: {"type":"watching","path":"/workspace/test","watchId":"watch-1"}\n\n'
      );
      const cancel = vi.fn(async () => undefined);
      const dispose = vi.fn();
      vi.mocked(
        asSandboxWithClient(sandbox).client.watch.watch
      ).mockResolvedValue({
        stream: vi.fn(
          async () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(chunk);
              }
            })
        ),
        cancel,
        [Symbol.dispose]: dispose
      });

      const stream = await sandbox.watch('/workspace/test');
      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: chunk
      });
      await reader.cancel();

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('keeps file read streams owned until caller cancellation', async () => {
      const chunk = new TextEncoder().encode('chunk');
      const cancel = vi.fn(async () => undefined);
      vi.mocked(
        asSandboxWithClient(sandbox).client.files.readFileStream
      ).mockResolvedValue(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel
        })
      );

      const stream = await sandbox.readFileStream('/workspace/file.txt');
      expect(controlConnectionMockState.activated).toBe(true);

      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: chunk
      });
      expect(controlConnectionMockState.activated).toBe(true);

      await reader.cancel('done');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith('done');
    });

    it('does not wait for hanging remote file read cancellation', async () => {
      const chunk = new TextEncoder().encode('chunk');
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      vi.mocked(
        asSandboxWithClient(sandbox).client.files.readFileStream
      ).mockResolvedValue(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel
        })
      );

      const stream = await sandbox.readFileStream('/workspace/file.txt');
      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: chunk
      });

      const canceled = reader.cancel('caller done').then(() => true);
      const completedPromptly = await Promise.race([
        canceled,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))
      ]);

      expect(completedPromptly).toBe(true);
      expect(cancel).toHaveBeenCalledWith('caller done');
    });

    it('does not wait for hanging remote watch cancellation', async () => {
      const chunk = new TextEncoder().encode(
        'data: {"type":"watching","path":"/workspace/test","watchId":"watch-1"}\n\n'
      );
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const dispose = vi.fn();
      vi.mocked(
        asSandboxWithClient(sandbox).client.watch.watch
      ).mockResolvedValue({
        stream: vi.fn(
          async () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(chunk);
              }
            })
        ),
        cancel,
        [Symbol.dispose]: dispose
      });

      const stream = await sandbox.watch('/workspace/test');
      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: chunk
      });

      const canceled = reader.cancel('caller done').then(() => true);
      const completedPromptly = await Promise.race([
        canceled,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))
      ]);

      expect(completedPromptly).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('cancels caller-supplied write streams when stream RPC rejects', async () => {
      const sourceCancel = vi.fn(async () => undefined);
      const rpcError = new Error('stream rpc failed');
      vi.mocked(
        asSandboxWithClient(sandbox).client.files.writeFileStream
      ).mockRejectedValue(rpcError);
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('chunk'));
        },
        cancel: sourceCancel
      });

      await expect(
        sandbox.writeFile('/workspace/file.txt', source)
      ).rejects.toThrow(rpcError.message);

      expect(sourceCancel).toHaveBeenCalledTimes(1);
      expect(sourceCancel).toHaveBeenCalledWith('writeFileStream completed');
      expect(
        (
          sandbox as unknown as {
            resourceActivityGate: { activityInFlight: number };
          }
        ).resourceActivityGate.activityInFlight
      ).toBe(0);
    });

    it('invalidates retained file read streams when the runtime stops', async () => {
      const chunk = new TextEncoder().encode('chunk');
      const cancel = vi.fn(async () => undefined);
      let pushed = false;
      vi.mocked(
        asSandboxWithClient(sandbox).client.files.readFileStream
      ).mockResolvedValue(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (!pushed) {
              pushed = true;
              controller.enqueue(chunk);
            }
          },
          cancel
        })
      );

      const stream = await sandbox.readFileStream('/workspace/file.txt');
      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: chunk
      });

      const pendingRead = reader.read();
      (
        sandbox as unknown as { runtimeSessions: { closeActive(): void } }
      ).runtimeSessions.closeActive();

      await expect(pendingRead).rejects.toMatchObject({
        code: ErrorCode.OPERATION_INTERRUPTED
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('releases file read stream ownership exactly once on source error', async () => {
      const sourceError = new Error('source failed');
      const cancel = vi.fn(async () => undefined);
      vi.mocked(
        asSandboxWithClient(sandbox).client.files.readFileStream
      ).mockResolvedValue(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(sourceError);
          },
          cancel
        })
      );

      const stream = await sandbox.readFileStream('/workspace/file.txt');
      const reader = stream.getReader();

      await expect(reader.read()).rejects.toThrow(sourceError);
      await sandbox.onStop();
      expect(cancel).not.toHaveBeenCalled();
    });

    it('should forward checkChanges options to the watch client', async () => {
      await sandbox.checkChanges('/workspace/test', {
        since: 'watch-1:0',
        recursive: false
      });
      expect(
        asSandboxWithClient(sandbox).client.watch.checkChanges
      ).toHaveBeenCalledWith({
        path: '/workspace/test',
        recursive: false,
        include: undefined,
        exclude: undefined,
        since: 'watch-1:0'
      });
    });
  });

  describe('port exposure - workers.dev detection', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox');
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
    });
  });

  describe('containerFetch() direct forwarding', () => {
    it('retains direct HTTP response bodies until runtime invalidation', async () => {
      const bodyRead = deferred<Uint8Array>();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              controller.enqueue(await bodyRead.promise);
            } catch {
              // The retained wrapper may error the stream while this pull is pending.
            }
          }
        }),
        {
          status: 202,
          statusText: 'Accepted',
          headers: { 'x-test': 'body' }
        }
      );
      const tcpFetch = vi.fn(async () => response);
      mockCtx.container.getTcpPort = vi.fn(() => ({ fetch: tcpFetch }));

      const forwarded = await sandbox.containerFetch(
        new Request('https://example.com/data'),
        8080
      );
      const reader = forwarded.body!.getReader();
      const pendingRead = reader.read();
      const readExpectation = expect(pendingRead).rejects.toMatchObject({
        code: ErrorCode.OPERATION_INTERRUPTED
      });
      await sandbox.stop();
      bodyRead.resolve(new Uint8Array([1]));

      await readExpectation;
      expect(forwarded.status).toBe(202);
      expect(forwarded.statusText).toBe('Accepted');
      expect(forwarded.headers.get('x-test')).toBe('body');
      expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
      expect(tcpFetch).toHaveBeenCalledOnce();
    });

    it('releases direct HTTP responses without bodies immediately', async () => {
      const tcpFetch = vi.fn(async () => new Response(null, { status: 204 }));
      mockCtx.container.getTcpPort = vi.fn(() => ({ fetch: tcpFetch }));

      const forwarded = await sandbox.containerFetch(
        new Request('https://example.com/empty'),
        8080
      );
      await sandbox.stop();

      expect(forwarded.status).toBe(204);
      expect(forwarded.body).toBeNull();
      expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
      expect(tcpFetch).toHaveBeenCalledOnce();
    });

    it('propagates caller abort during direct HTTP port readiness', async () => {
      const releaseReadiness = deferred<void>();
      vi.mocked(
        asSandboxWithClient(sandbox).client.ports.openWatch
      ).mockResolvedValueOnce({
        stream: vi.fn(
          async () =>
            new ReadableStream({
              async start(controller) {
                await releaseReadiness.promise;
                controller.enqueue({ type: 'ready' });
                controller.close();
              }
            })
        ),
        cancel: vi.fn(async () => undefined),
        [Symbol.dispose]: vi.fn()
      });
      const controller = new AbortController();
      const reason = new DOMException('caller stopped', 'AbortError');
      const forwarded = sandbox.containerFetch(
        new Request('https://example.com/data', { signal: controller.signal }),
        8080
      );

      await vi.waitFor(() =>
        expect(
          asSandboxWithClient(sandbox).client.ports.openWatch
        ).toHaveBeenCalled()
      );
      controller.abort(reason);
      releaseReadiness.resolve();

      await expect(forwarded).rejects.toBe(reason);
    });

    it('passes caller abort into direct HTTP runtime establishment', async () => {
      const controller = new AbortController();
      const reason = new DOMException('caller stopped', 'AbortError');
      const runWaking = vi
        .spyOn(getPreviewRuntimeRunner(sandbox), 'runWaking')
        .mockImplementationOnce(async (_operation, _call, options) => {
          expect(options?.signal).toBe(controller.signal);
          controller.abort(reason);
          throw reason;
        });

      await expect(
        sandbox.containerFetch(
          new Request('https://example.com/data', {
            signal: controller.signal
          }),
          8080
        )
      ).rejects.toBe(reason);

      expect(runWaking).toHaveBeenCalledWith(
        'container.fetch',
        expect.any(Function),
        { signal: controller.signal }
      );
    });

    it('interrupts direct HTTP forwarding during port readiness without physical forwarding', async () => {
      const releaseReadiness = deferred<void>();
      vi.mocked(
        asSandboxWithClient(sandbox).client.ports.openWatch
      ).mockResolvedValueOnce({
        stream: vi.fn(
          async () =>
            new ReadableStream({
              async start(controller) {
                await releaseReadiness.promise;
                controller.enqueue({ type: 'ready' });
                controller.close();
              }
            })
        ),
        cancel: vi.fn(async () => undefined),
        [Symbol.dispose]: vi.fn()
      });
      const tcpFetch = vi.fn();
      mockCtx.container.getTcpPort = vi.fn(() => ({ fetch: tcpFetch }));

      const forwarded = sandbox.containerFetch(
        new Request('https://example.com/data'),
        8080
      );
      const forwardExpectation = expect(forwarded).rejects.toMatchObject({
        code: ErrorCode.OPERATION_INTERRUPTED
      });
      await vi.waitFor(() =>
        expect(
          asSandboxWithClient(sandbox).client.ports.openWatch
        ).toHaveBeenCalledWith(8080, expect.any(Object))
      );
      await sandbox.stop();
      releaseReadiness.resolve();

      await forwardExpectation;
      expect(tcpFetch).not.toHaveBeenCalled();
    });
  });

  describe('fetch() override - WebSocket detection', () => {
    let tcpFetch: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox');
      tcpFetch = vi.fn(async () => new Response(null, { status: 204 }));
      mockCtx.container.getTcpPort = vi.fn(() => ({ fetch: tcpFetch }));
    });

    it('passes caller abort into WebSocket runtime establishment', async () => {
      const controller = new AbortController();
      const reason = new DOMException('caller stopped', 'AbortError');
      const runWaking = vi
        .spyOn(getPreviewRuntimeRunner(sandbox), 'runWaking')
        .mockImplementationOnce(async (_operation, _call, options) => {
          expect(options?.signal).toBe(controller.signal);
          controller.abort(reason);
          throw reason;
        });
      const request = new Request('https://example.com/ws', {
        signal: controller.signal,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        }
      });

      await expect(sandbox.fetch(request)).rejects.toBe(reason);

      expect(runWaking).toHaveBeenCalledWith(
        'container.websocket',
        expect.any(Function),
        { signal: controller.signal }
      );
    });

    it('should detect WebSocket upgrade header and route through admitted TCP port', async () => {
      const request = new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        }
      });

      tcpFetch.mockResolvedValueOnce(new Response('WebSocket response'));

      const response = await sandbox.fetch(request);

      expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(3000);
      expect(tcpFetch).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe('WebSocket response');
    });

    it.each([
      ['GET', new Request('https://example.com/api/data')],
      [
        'POST',
        new Request('https://example.com/api/data', {
          method: 'POST',
          body: JSON.stringify({ data: 'test' }),
          headers: { 'Content-Type': 'application/json' }
        })
      ],
      [
        'SSE',
        new Request('https://example.com/events', {
          headers: { Accept: 'text/event-stream' }
        })
      ]
    ])(
      'should route non-WebSocket %s requests through containerFetch',
      async (_kind, request) => {
        await (await sandbox.fetch(request)).text();
        expect(tcpFetch).toHaveBeenCalledTimes(1);
      }
    );

    it('should preserve WebSocket request unchanged when forwarding through admitted TCP port', async () => {
      const request = new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'test-key-123',
          'Sec-WebSocket-Version': '13'
        }
      });

      await sandbox.fetch(request);

      expect(tcpFetch).toHaveBeenCalledTimes(1);
      const passedRequest = tcpFetch.mock.calls[0][0] as Request;
      expect(passedRequest.headers.get('Upgrade')).toBe('websocket');
      expect(passedRequest.headers.get('Connection')).toBe('Upgrade');
      expect(passedRequest.headers.get('Sec-WebSocket-Key')).toBe(
        'test-key-123'
      );
      expect(passedRequest.headers.get('Sec-WebSocket-Version')).toBe('13');
    });

    it('closes direct WebSocket forwarding when the runtime is invalidated', async () => {
      const socket = new FakeSocket();
      const response = new Response('WebSocket response');
      Object.defineProperty(response, 'webSocket', { value: socket });
      tcpFetch.mockResolvedValueOnce(response);
      const request = new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        }
      });

      await sandbox.fetch(request);
      await sandbox.stop();

      expect(socket.closeCalls).toEqual([
        { code: 1012, reason: 'Runtime replaced' }
      ]);
    });

    it('closes direct WebSocket assignment race responses on invalidation', async () => {
      const socket = new FakeSocket();
      const response = new Response('WebSocket response');
      Object.defineProperty(response, 'webSocket', { value: socket });
      const releaseFetch = deferred<Response>();
      tcpFetch.mockImplementationOnce(() => releaseFetch.promise);
      const request = new Request('https://example.com/ws', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        }
      });

      const forwarded = sandbox.fetch(request);
      const forwardExpectation = expect(forwarded).rejects.toMatchObject({
        code: ErrorCode.OPERATION_INTERRUPTED
      });
      await vi.waitFor(() => expect(tcpFetch).toHaveBeenCalledOnce());
      await sandbox.stop();
      releaseFetch.resolve(response);

      await forwardExpectation;
      expect(socket.closeCalls).toEqual([
        { code: 1012, reason: 'Runtime replaced' }
      ]);
    });

    it('routes active preview proxy requests through the TCP port without starting', async () => {
      const tcpFetch = vi.fn().mockResolvedValue(new Response('preview ok'));
      mockCtx.container.running = true;
      mockCtx.container.getTcpPort = vi
        .fn()
        .mockReturnValue({ fetch: tcpFetch });
      mockPreviewStorageGet(mockCtx, activePreviewStorageState());
      const containerFetchSpy = vi.spyOn(sandbox, 'containerFetch');
      const startAndWaitSpy = vi.spyOn(sandbox, 'startAndWaitForPorts');
      const runtimeRunner = getPreviewRuntimeRunner(sandbox);
      const runExistingSpy = vi.spyOn(runtimeRunner, 'runExisting');
      const runWakingSpy = vi.spyOn(runtimeRunner, 'runWaking');

      const response = await sandbox.fetch(
        createPreviewProxyRequest('/hello?x=1')
      );

      expect(await response.text()).toBe('preview ok');
      expect(containerFetchSpy).not.toHaveBeenCalled();
      expect(startAndWaitSpy).not.toHaveBeenCalled();
      expect(mockCtx.container.start).not.toHaveBeenCalled();
      expect(runExistingSpy).toHaveBeenCalledTimes(1);
      expect(runExistingSpy).toHaveBeenCalledWith(
        { kind: 'current' },
        'preview.forward',
        expect.any(Function)
      );
      expect(runWakingSpy).not.toHaveBeenCalled();
      expect(mockCtx.container.getTcpPort).toHaveBeenCalledWith(8080);
      expect(tcpFetch).toHaveBeenCalledWith(
        'http://localhost:8080/hello?x=1',
        expect.any(Request)
      );
      const forwardedRequest = tcpFetch.mock.calls[0][1] as Request;
      expect(forwardedRequest.headers.get('X-Sandbox-Name')).toBe(
        'test-sandbox'
      );
    });

    it('preserves WebSocket preview proxy requests when forwarding', async () => {
      const tcpFetch = vi
        .fn()
        .mockResolvedValue(new Response('preview websocket ok'));
      mockCtx.container.running = true;
      mockCtx.container.getTcpPort = vi
        .fn()
        .mockReturnValue({ fetch: tcpFetch });
      mockPreviewStorageGet(mockCtx, activePreviewStorageState());

      const request = createPreviewWebSocketRequest();

      await sandbox.fetch(request);

      expect(tcpFetch).toHaveBeenCalledTimes(1);
      const forwardedRequest = tcpFetch.mock.calls[0][1] as Request;
      expect(forwardedRequest.url).toBe(request.url);
      expect(forwardedRequest.headers.get('Upgrade')).toBe('websocket');
      expect(forwardedRequest.headers.get('Connection')).toBe('Upgrade');
      expect(forwardedRequest.headers.get('Sec-WebSocket-Key')).toBe(
        'test-key-123'
      );
      expect(forwardedRequest.headers.get('Sec-WebSocket-Version')).toBe('13');
      expect(forwardedRequest.headers.has('x-sandbox-preview-proxy')).toBe(
        false
      );
    });

    it('returns user 503 responses when the runtime remains active', async () => {
      const tcpFetch = vi
        .fn()
        .mockResolvedValue(
          new Response('service temporarily unavailable', { status: 503 })
        );
      mockCtx.container.running = true;
      mockCtx.container.getTcpPort = vi
        .fn()
        .mockReturnValue({ fetch: tcpFetch });
      mockPreviewStorageGet(mockCtx, activePreviewStorageState());

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(503);
      expect(await response.text()).toBe('service temporarily unavailable');
    });

    it('returns stale without forwarding when the container is stopped', async () => {
      mockCtx.container.running = false;
      mockCtx.container.getTcpPort = vi.fn();
      mockPreviewStorageGet(mockCtx, activePreviewStorageState());
      const containerFetchSpy = vi.spyOn(sandbox, 'containerFetch');
      const startAndWaitSpy = vi.spyOn(sandbox, 'startAndWaitForPorts');
      const runtimeRunner = getPreviewRuntimeRunner(sandbox);
      const runExistingSpy = vi.spyOn(runtimeRunner, 'runExisting');
      const runWakingSpy = vi.spyOn(runtimeRunner, 'runWaking');

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
      expect(mockCtx.container.getTcpPort).not.toHaveBeenCalled();
      expect(containerFetchSpy).not.toHaveBeenCalled();
      expect(startAndWaitSpy).not.toHaveBeenCalled();
      expect(runExistingSpy).toHaveBeenCalledTimes(1);
      expect(runWakingSpy).not.toHaveBeenCalled();
      expect(mockCtx.container.start).not.toHaveBeenCalled();
    });

    it('returns stale when the runtime goes inactive during network loss', async () => {
      mockCtx.container.running = true;
      let runtimeActive = true;
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        const state = activePreviewStorageState();
        if (key === 'currentRuntimeIdentity') {
          return runtimeActive ? state.currentRuntimeIdentity : null;
        }
        return state[key as keyof typeof state] ?? null;
      });
      const tcpFetch = vi.fn().mockImplementation(async () => {
        runtimeActive = false;
        throw new Error('Network connection lost.');
      });
      mockCtx.container.getTcpPort = vi
        .fn()
        .mockReturnValue({ fetch: tcpFetch });

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
    });

    it('returns stale response when preview forwarding loses the network', async () => {
      mockCtx.container.running = true;
      mockPreviewStorageGet(mockCtx, activePreviewStorageState());
      const tcpFetch = vi
        .fn()
        .mockRejectedValue(new Error('Network connection lost.'));
      mockCtx.container.getTcpPort = vi
        .fn()
        .mockReturnValue({ fetch: tcpFetch });

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
    });

    it('rejects preview proxy requests without durable authorization', async () => {
      mockCtx.container.running = true;
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) =>
        key === 'portTokens' ? {} : null
      );
      const containerFetchSpy = vi.spyOn(sandbox, 'containerFetch');
      const runtimeRunner = getPreviewRuntimeRunner(sandbox);
      const runExistingSpy = vi.spyOn(runtimeRunner, 'runExisting');
      const runWakingSpy = vi.spyOn(runtimeRunner, 'runWaking');

      const response = await sandbox.fetch(
        new Request('https://8080-test-sandbox-badtoken.example.com/api', {
          headers: {
            'x-sandbox-preview-proxy': '1',
            'x-sandbox-preview-port': '8080',
            'x-sandbox-preview-token': 'badtoken',
            'x-sandbox-preview-sandbox-id': 'test-sandbox'
          }
        })
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: 'INVALID_TOKEN'
      });
      expect(containerFetchSpy).not.toHaveBeenCalled();
      expect(runExistingSpy).not.toHaveBeenCalled();
      expect(runWakingSpy).not.toHaveBeenCalled();
    });

    it('rejects preview proxy requests without current-runtime activation', async () => {
      mockCtx.container.running = true;
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return { '8080': { token: 'token12345678901' } };
        }
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'activePreviewPorts') {
          return {};
        }
        return null;
      });
      const containerFetchSpy = vi.spyOn(sandbox, 'containerFetch');

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
      expect(containerFetchSpy).not.toHaveBeenCalled();
    });

    it('rejects preview proxy requests when activation belongs to another runtime', async () => {
      mockCtx.container.running = true;
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        const state = {
          ...activePreviewStorageState(),
          activePreviewPorts: {
            '8080': {
              runtimeIdentityID: 'runtime-2',
              runtimeIncarnationID: 'test-incarnation',
              token: PREVIEW_TEST_TOKEN
            }
          }
        };
        return state[key as keyof typeof state] ?? null;
      });
      const tcpFetch = vi.fn().mockResolvedValue(new Response('preview ok'));
      mockCtx.container.getTcpPort = vi
        .fn()
        .mockReturnValue({ fetch: tcpFetch });
      const runtimeRunner = getPreviewRuntimeRunner(sandbox);
      const runExistingSpy = vi.spyOn(runtimeRunner, 'runExisting');
      const runWakingSpy = vi.spyOn(runtimeRunner, 'runWaking');

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
      expect(runExistingSpy).toHaveBeenCalledTimes(1);
      expect(runWakingSpy).not.toHaveBeenCalled();
      expect(tcpFetch).not.toHaveBeenCalled();
      expect(mockCtx.container.start).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'same runtime id with another incarnation',
        activation: {
          runtimeIdentityID: PREVIEW_TEST_RUNTIME_ID,
          runtimeIncarnationID: 'old-incarnation',
          token: PREVIEW_TEST_TOKEN
        },
        expectedAdmissions: 1
      },
      {
        name: 'legacy activation without an incarnation',
        activation: {
          runtimeIdentityID: PREVIEW_TEST_RUNTIME_ID,
          token: PREVIEW_TEST_TOKEN
        },
        expectedAdmissions: 0
      }
    ])(
      'clears stale preview activation for $name',
      async ({ activation, expectedAdmissions }) => {
        const state = activePreviewStorageState();
        const storage = new Map<string, unknown>([
          ...Object.entries(state),
          ['activePreviewPorts', { '8080': activation }]
        ]);
        mockCtx.storage.get.mockImplementation(
          async (key: string) => storage.get(key) ?? null
        );
        mockCtx.storage.put.mockImplementation(async (key: string, value) => {
          storage.set(key, value);
        });
        mockCtx.storage.delete.mockImplementation(async (key: string) => {
          storage.delete(key);
        });
        mockCtx.storage.transaction.mockImplementation(
          async (callback: (txn: typeof mockCtx.storage) => Promise<unknown>) =>
            await callback(mockCtx.storage)
        );
        mockCtx.container.running = true;
        const tcpFetch = vi.fn().mockResolvedValue(new Response('preview ok'));
        mockCtx.container.getTcpPort = vi
          .fn()
          .mockReturnValue({ fetch: tcpFetch });
        const runExisting = vi.spyOn(
          getPreviewRuntimeRunner(sandbox),
          'runExisting'
        );

        const response = await sandbox.fetch(createPreviewProxyRequest());

        expect(response.status).toBe(410);
        expect(runExisting).toHaveBeenCalledTimes(expectedAdmissions);
        expect(tcpFetch).not.toHaveBeenCalled();
        expect(storage.has('activePreviewPorts')).toBe(false);
        expect(mockCtx.container.start).not.toHaveBeenCalled();
      }
    );

    it('clears preview activation when reconstructed session observes a changed incarnation', async () => {
      const storage = new Map<string, unknown>(
        Object.entries(activePreviewStorageState())
      );
      mockCtx.storage.get.mockImplementation(
        async (key: string) => storage.get(key) ?? null
      );
      mockCtx.storage.put.mockImplementation(async (key: string, value) => {
        storage.set(key, value);
      });
      mockCtx.storage.delete.mockImplementation(async (key: string) => {
        storage.delete(key);
      });
      mockCtx.storage.transaction.mockImplementation(
        async (callback: (txn: typeof mockCtx.storage) => Promise<unknown>) =>
          await callback(mockCtx.storage)
      );
      const tcpFetch = vi.fn().mockResolvedValue(new Response('preview ok'));
      mockCtx.container.running = true;
      mockCtx.container.getTcpPort = vi
        .fn()
        .mockReturnValue({ fetch: tcpFetch });
      vi.spyOn(
        getPreviewRuntimeRunner(sandbox),
        'runExisting'
      ).mockRejectedValueOnce(
        new RuntimeControlProtocolError('Runtime incarnation does not match', {
          reason: 'activation-mismatch',
          operation: 'utils.activateControlSession'
        })
      );

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
      expect(tcpFetch).not.toHaveBeenCalled();
      expect(storage.get('activePreviewPorts')).toBeUndefined();
      expect(mockCtx.container.start).not.toHaveBeenCalled();
    });

    it('rejects persisted preview auth without runtime identity or activation', async () => {
      mockCtx.container.running = true;
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return { '8080': { token: 'token12345678901' } };
        }
        if (key === 'currentRuntimeIdentity') {
          return null;
        }
        if (key === 'activePreviewPorts') {
          return null;
        }
        return null;
      });
      const containerFetchSpy = vi.spyOn(sandbox, 'containerFetch');

      const response = await sandbox.fetch(createPreviewProxyRequest());

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
      expect(containerFetchSpy).not.toHaveBeenCalled();
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
      mockCtx.container.getTcpPort = vi.fn(() => ({
        fetch: vi.fn(
          async () =>
            new Response('WebSocket Upgraded', {
              status: 200,
              headers: { 'X-WebSocket-Upgraded': 'true' }
            })
        )
      }));

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

  describe('constructPreviewUrl validation', () => {
    it('should throw clear error for ID with uppercase letters without normalizeId', async () => {
      await sandbox.setSandboxName('MyProject-123', false);
      await expect(
        sandbox.exposePort(8080, { hostname: 'example.com' })
      ).rejects.toThrow(/Preview URLs require lowercase sandbox IDs/);
    });

    it('should construct valid URL for lowercase ID', async () => {
      await sandbox.setSandboxName('my-project', false);
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
      const result = await sandbox.exposePort(4000, { hostname: 'my-app.dev' });

      expect(result.url).toMatch(
        /^https:\/\/4000-myproject-123-[a-z0-9_]{16}\.my-app\.dev\/?$/
      );
      expect(result.port).toBe(4000);
    });

    it('should construct valid localhost URL', async () => {
      await sandbox.setSandboxName('test-sandbox', false);
      const result = await sandbox.exposePort(8080, {
        hostname: 'localhost:3000'
      });

      expect(result.url).toMatch(
        /^http:\/\/8080-test-sandbox-[a-z0-9_]{16}\.localhost:3000\/?$/
      );
    });

    it('should include helpful guidance in error message', async () => {
      await sandbox.setSandboxName('MyProject-ABC', false);
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

      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') return runtimeRecord('runtime-a');
        if (key === 'portTokens' || key === 'activePreviewPorts') return {};
        return null;
      });
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

      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') return runtimeRecord('runtime-a');
        if (key === 'portTokens') return { '8080': 'shared' };
        if (key === 'activePreviewPorts') return {};
        return null;
      });
      const runWakingSpy = vi.spyOn(
        getPreviewRuntimeRunner(sandbox),
        'runWaking'
      );

      await expect(
        sandbox.exposePort(8081, { hostname: 'example.com', token: 'shared' })
      ).rejects.toThrow(/already in use by port 8080/);
      expect(runWakingSpy).not.toHaveBeenCalled();
    });

    it('should allow re-exposing same port with same token', async () => {
      await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'stable'
      });

      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') return runtimeRecord('runtime-a');
        if (key === 'portTokens') return { '8080': 'stable' };
        if (key === 'activePreviewPorts') return {};
        return null;
      });

      const result = await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'stable'
      });
      expect(result.url).toContain('stable');
    });
  });

  describe('preview URL runtime activation', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox', false);
    });

    it('exposePort() uses one waking preview scope and no legacy preview starter', async () => {
      const storage = new Map<string, unknown>([
        ['portTokens', { '8080': { token: 'tok8080', name: 'api' } }]
      ]);
      vi.mocked(mockCtx.storage!.get).mockImplementation(
        async (key) => storage.get(String(key)) ?? null
      );
      vi.mocked(mockCtx.storage!.put).mockImplementation(async (key, value) => {
        storage.set(String(key), value);
      });
      const runtimeRunner = (
        sandbox as unknown as {
          runtimeRunner: {
            runWaking<T>(
              operation: string,
              call: (lease: {
                runtime: unknown;
                retain(): { release(): void };
              }) => Promise<T>
            ): Promise<T>;
          };
        }
      ).runtimeRunner;
      const runWakingSpy = vi.spyOn(runtimeRunner, 'runWaking');

      await sandbox.exposePort(9090, {
        hostname: 'example.com',
        token: 'newtoken'
      });

      expect(runWakingSpy).toHaveBeenCalledTimes(1);
      expect(runWakingSpy).toHaveBeenCalledWith(
        'preview.expose',
        expect.any(Function)
      );
      expect('ensureRuntimeActiveForPreview' in sandbox).toBe(false);
      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        'activePreviewPorts',
        expect.objectContaining({
          '9090': expect.objectContaining({ token: 'newtoken' })
        })
      );
      expect(mockCtx.storage.put).not.toHaveBeenCalledWith(
        'activePreviewPorts',
        expect.objectContaining({
          '8080': expect.anything()
        })
      );
    });

    it('onStop() preserves durable auth and clears runtime-scoped preview state', async () => {
      await (sandbox as any).onStop();

      const deletedKeys = vi
        .mocked(mockCtx.storage!.delete)
        .mock.calls.map((call) => call[0]);
      expect(deletedKeys).not.toContain('portTokens');
      expect(deletedKeys).toContain('activePreviewPorts');
      expect(deletedKeys).toContain('currentRuntimeIdentity');
    });

    it('stop() clears runtime-scoped preview state before signaling the container', async () => {
      const callOrder: string[] = [];
      vi.mocked(mockCtx.storage!.delete).mockImplementation(async (key) => {
        callOrder.push(`delete:${String(key)}`);
      });
      vi.spyOn(Container.prototype, 'stop').mockImplementation(async () => {
        callOrder.push('super.stop');
      });

      await sandbox.stop();

      expect(callOrder.indexOf('delete:activePreviewPorts')).toBeLessThan(
        callOrder.indexOf('super.stop')
      );
      expect(callOrder.indexOf('delete:currentRuntimeIdentity')).toBeLessThan(
        callOrder.indexOf('super.stop')
      );
      expect(callOrder).not.toContain('delete:portTokens');
    });

    it('start() waits behind an explicit stop and establishes only after stop settles', async () => {
      const callOrder: string[] = [];
      const stopGate = deferred<void>();
      const parent = Object.getPrototypeOf(Object.getPrototypeOf(sandbox)) as {
        stop: () => Promise<void>;
        startAndWaitForPorts: () => Promise<void>;
      };
      vi.spyOn(parent, 'stop').mockImplementation(async () => {
        callOrder.push('super.stop:start');
        await stopGate.promise;
        mockCtx.container.running = false;
        callOrder.push('super.stop:end');
      });
      vi.spyOn(parent, 'startAndWaitForPorts').mockImplementation(async () => {
        callOrder.push('super.startAndWaitForPorts');
        mockCtx.container.running = true;
      });

      const stop = sandbox.stop();
      await vi.waitFor(() => expect(callOrder).toContain('super.stop:start'));
      const start = sandbox.start();
      await Promise.resolve();

      expect(callOrder).not.toContain('super.startAndWaitForPorts');
      stopGate.resolve();
      await stop;
      await start;

      expect(callOrder).toEqual([
        'super.stop:start',
        'super.stop:end',
        'super.startAndWaitForPorts'
      ]);
    });

    it('destroy() waits for a pending explicit stop then still destroys', async () => {
      const callOrder: string[] = [];
      const stopGate = deferred<void>();
      const parent = Object.getPrototypeOf(Object.getPrototypeOf(sandbox)) as {
        stop: () => Promise<void>;
        destroy: () => Promise<void>;
      };
      vi.spyOn(parent, 'stop').mockImplementation(async () => {
        callOrder.push('super.stop:start');
        await stopGate.promise;
        callOrder.push('super.stop:end');
      });
      vi.spyOn(parent, 'destroy').mockImplementation(async () => {
        callOrder.push('super.destroy');
      });

      const stop = sandbox.stop();
      await vi.waitFor(() => expect(callOrder).toContain('super.stop:start'));
      const destroy = sandbox.destroy();
      await Promise.resolve();

      expect(callOrder).not.toContain('super.destroy');
      stopGate.resolve();
      await stop;
      await destroy;

      expect(callOrder).toEqual([
        'super.stop:start',
        'super.stop:end',
        'super.destroy'
      ]);
    });

    it('failed physical destroy leaves runtime authority invalidated', async () => {
      vi.spyOn(Container.prototype, 'destroy').mockRejectedValue(
        new Error('physical destroy failed')
      );

      await expect(sandbox.destroy()).rejects.toThrow(
        'physical destroy failed'
      );

      expect(mockCtx.storage.delete).toHaveBeenCalledWith(
        'currentRuntimeIdentity'
      );
      await expect((sandbox as any).isRuntimeActive()).resolves.toBe(false);
    });

    it('destroy() clears preview auth and runtime-scoped state before calling super.destroy()', async () => {
      const callOrder: string[] = [];

      vi.mocked(mockCtx.storage!.delete).mockImplementation(async (key) => {
        callOrder.push(`delete:${String(key)}`);
      });

      vi.spyOn(Container.prototype, 'destroy').mockImplementation(async () => {
        callOrder.push('super.destroy');
      });

      await sandbox.destroy();

      const superIdx = callOrder.indexOf('super.destroy');
      for (const key of [
        'portTokens',
        'activePreviewPorts',
        'currentRuntimeIdentity'
      ]) {
        const deleteIdx = callOrder.indexOf(`delete:${key}`);
        expect(deleteIdx).toBeGreaterThanOrEqual(0);
        expect(deleteIdx).toBeLessThan(superIdx);
      }
    });

    it('exposePort() persists durable auth and current-runtime activation', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return {};
        }
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'activePreviewPorts') {
          return {};
        }
        return null;
      });
      const putSpy = vi.mocked(mockCtx.storage!.put);

      await sandbox.exposePort(8080, {
        hostname: 'example.com',
        token: 'friendlytok',
        name: 'my-api'
      });
      expect(putSpy).toHaveBeenCalledWith('portTokens', {
        '8080': { token: 'friendlytok', name: 'my-api' }
      });
      expect(putSpy).toHaveBeenCalledWith('activePreviewPorts', {
        '8080': {
          runtimeIdentityID: 'runtime-1',
          runtimeIncarnationID: 'test-incarnation',
          token: 'friendlytok'
        }
      });
    });

    it('exposePort() rolls back preview state when the post-write fence fails', async () => {
      const storage = new Map<string, unknown>([
        ['currentRuntimeIdentity', runtimeRecord('runtime-1')]
      ]);
      mockCtx.storage.get.mockImplementation(
        async (key: string) => storage.get(key) ?? null
      );
      mockCtx.storage.put.mockImplementation(async (key: string, value) => {
        storage.set(key, value);
      });
      mockCtx.storage.delete.mockImplementation(async (key: string) => {
        storage.delete(key);
      });
      mockCtx.storage.transaction.mockImplementation(
        async (callback: (txn: typeof mockCtx.storage) => Promise<unknown>) =>
          await callback(mockCtx.storage)
      );
      const lifecycle = getPreviewRuntimeLifecycle(sandbox);
      const assertActive = lifecycle.assertActive.bind(lifecycle);
      vi.spyOn(lifecycle, 'assertActive').mockImplementation(
        async (runtime) => {
          if (storage.has('activePreviewPorts')) {
            throw new RuntimeIdentityInactiveError();
          }
          await assertActive(runtime);
        }
      );

      await expect(
        sandbox.exposePort(8080, {
          hostname: 'example.com',
          token: 'friendlytok'
        })
      ).rejects.toMatchObject({
        code: 'OPERATION_INTERRUPTED',
        context: { operation: 'preview.expose' }
      });

      expect(storage.get('portTokens')).toEqual({});
      expect(storage.has('activePreviewPorts')).toBe(false);
    });

    it('exposePort() does not write preview state when runtime identity changes before storage writes', async () => {
      let runtimeIdentityReads = 0;
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return {};
        }
        if (key === 'currentRuntimeIdentity') {
          runtimeIdentityReads++;
          return runtimeRecord(
            runtimeIdentityReads === 1 ? 'runtime-1' : 'runtime-2'
          );
        }
        if (key === 'activePreviewPorts') {
          return {};
        }
        return null;
      });
      vi.mocked(mockCtx.storage!.put).mockClear();

      await expect(
        sandbox.exposePort(8080, {
          hostname: 'example.com',
          token: 'friendlytok'
        })
      ).rejects.toMatchObject({
        code: 'OPERATION_INTERRUPTED',
        context: { operation: 'preview.expose' }
      });

      expect(mockCtx.storage.put).not.toHaveBeenCalledWith(
        'portTokens',
        expect.anything()
      );
      expect(mockCtx.storage.put).not.toHaveBeenCalledWith(
        'activePreviewPorts',
        expect.anything()
      );
    });

    it('exposePort() rejects before preview state writes when runtime identity changes after activation', async () => {
      let runtimeIdentityReads = 0;
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return {};
        }
        if (key === 'currentRuntimeIdentity') {
          runtimeIdentityReads++;
          return runtimeRecord(
            runtimeIdentityReads <= 2 ? 'runtime-1' : 'runtime-2'
          );
        }
        if (key === 'activePreviewPorts') {
          return {};
        }
        return null;
      });
      vi.mocked(mockCtx.storage!.put).mockClear();

      await expect(
        sandbox.exposePort(8080, {
          hostname: 'example.com',
          token: 'friendlytok'
        })
      ).rejects.toMatchObject({
        code: 'OPERATION_INTERRUPTED',
        context: { operation: 'preview.expose' }
      });

      expect(mockCtx.storage.put).not.toHaveBeenCalledWith(
        'portTokens',
        expect.anything()
      );
      expect(mockCtx.storage.put).not.toHaveBeenCalledWith(
        'activePreviewPorts',
        expect.anything()
      );
    });

    it('exposePort() reuses the existing token when re-exposing the same port without a token', async () => {
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return { '8080': { token: 'stabletok' } };
        }
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'activePreviewPorts') {
          return {};
        }
        return null;
      });

      const result = await sandbox.exposePort(8080, {
        hostname: 'example.com'
      });

      expect(result.url).toContain('stabletok');
      expect(mockCtx.storage.put).toHaveBeenCalledWith(
        'activePreviewPorts',
        expect.objectContaining({
          '8080': expect.objectContaining({ token: 'stabletok' })
        })
      );
    });

    it('exposePort() does not restore a port revoked while the runtime starts', async () => {
      const storage = new Map<string, unknown>([
        ['portTokens', { '8080': { token: 'oldtoken' } }],
        ['currentRuntimeIdentity', runtimeRecord('runtime-1')],
        ['activePreviewPorts', {}]
      ]);
      mockCtx.storage.get.mockImplementation(
        async (key: string) => storage.get(key) ?? null
      );
      mockCtx.storage.put.mockImplementation(async (key: string, value) => {
        storage.set(key, value);
      });
      mockCtx.storage.delete.mockImplementation(async (key: string) => {
        storage.delete(key);
      });

      let releaseStartup!: () => void;
      const startupGate = new Promise<void>((resolve) => {
        releaseStartup = resolve;
      });
      const runtimeRunner = (
        sandbox as unknown as {
          runtimeRunner: {
            runWaking<T>(
              operation: string,
              call: (lease: {
                runtime: unknown;
                retain(): { release(): void };
              }) => Promise<T>
            ): Promise<T>;
          };
        }
      ).runtimeRunner;
      const runWakingSpy = vi
        .spyOn(runtimeRunner, 'runWaking')
        .mockImplementation(async (_operation, call) => {
          await startupGate;
          return call({
            runtime: {
              id: 'runtime-1',
              runtimeIncarnationID: 'test-incarnation'
            },
            retain: () => ({ release: () => {} })
          });
        });

      const exposePromise = sandbox.exposePort(9090, {
        hostname: 'example.com',
        token: 'newtoken'
      });
      await vi.waitFor(() => expect(runWakingSpy).toHaveBeenCalled());

      await sandbox.unexposePort(8080);
      expect(storage.get('portTokens')).toEqual({});

      releaseStartup();
      await exposePromise;

      expect(storage.get('portTokens')).toEqual({
        '9090': { token: 'newtoken', name: undefined }
      });
    });
  });

  describe('tunnels lifecycle storage', () => {
    function seedMixedTunnelStorage(): Array<{ key: string; value: unknown }> {
      const puts: Array<{ key: string; value: unknown }> = [];
      vi.mocked(mockCtx.storage!.get).mockImplementation(async (key) => {
        if (key === 'tunnels') {
          return {
            '8080': {
              id: 'quick-abc',
              port: 8080,
              url: 'https://x.trycloudflare.com',
              hostname: 'x.trycloudflare.com',
              createdAt: '2024-01-01T00:00:00.000Z'
            },
            '8081': {
              id: 'uuid-1',
              port: 8081,
              name: 'app',
              hostname: 'app.example.com',
              url: 'https://app.example.com',
              createdAt: '2024-01-01T00:00:00.000Z'
            }
          };
        }
        if (key === 'tunnels:meta') {
          return {
            '8080': { optionsHash: 'quick' },
            '8081': { optionsHash: 'named:app', dnsRecordId: 'rec-1' }
          };
        }
        return undefined as any;
      });
      vi.mocked(mockCtx.storage!.put).mockImplementation(
        async (key: string, value: unknown) => {
          puts.push({ key, value });
        }
      );
      (mockCtx.storage as unknown as { transaction: unknown }).transaction = vi
        .fn()
        .mockImplementation(
          async (closure: (txn: unknown) => Promise<unknown>) =>
            closure(mockCtx.storage)
        );
      return puts;
    }

    function expectOnlyNamedTunnelMetadataPreserved(
      puts: Array<{ key: string; value: unknown }>
    ): void {
      const nextTunnels = puts.find((p) => p.key === 'tunnels')
        ?.value as Record<string, { name?: string }>;
      const nextMeta = puts.find((p) => p.key === 'tunnels:meta')?.value as
        | Record<
            string,
            {
              needsRespawn?: boolean;
              tunnelId?: string;
              name?: string;
              hostname?: string;
            }
          >
        | undefined;

      expect(nextTunnels ?? {}).toEqual({});
      expect(nextMeta?.['8081']?.needsRespawn).toBe(true);
      expect(nextMeta?.['8081']?.tunnelId).toBe('uuid-1');
      expect(nextMeta?.['8081']?.name).toBe('app');
      expect(nextMeta?.['8081']?.hostname).toBe('app.example.com');
      expect(nextMeta?.['8080']).toBeUndefined();
    }

    it('onStop() hides named tunnels for respawn and drops quick ones', async () => {
      const puts = seedMixedTunnelStorage();

      await (sandbox as any).onStop();

      expectOnlyNamedTunnelMetadataPreserved(puts);
    });

    it('tunnels.get() records runtime and lifetime metadata', async () => {
      const storagePut = mockCtx.storage.put as unknown as (
        key: string,
        value: unknown
      ) => Promise<void>;
      const storageGet = mockCtx.storage.get as unknown as (
        key: string
      ) => Promise<unknown>;
      await storagePut('currentRuntimeIdentity', runtimeRecord('runtime-1'));
      await storagePut('sandbox:lifetime', {
        id: 'lifetime-1',
        generation: 1,
        createdAt: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.000Z'
      });
      vi.mocked(
        asSandboxWithClient(sandbox).client.tunnels.ensureTunnelRun
      ).mockImplementation(async (request) => ({
        started: true,
        run: {
          mode: 'quick',
          tunnelId: request.tunnelId,
          runId: request.runId,
          port: request.port,
          url: 'https://stub.trycloudflare.com',
          hostname: 'stub.trycloudflare.com',
          startedAt: '2026-06-18T00:00:00.000Z'
        }
      }));

      const runWaking = vi.spyOn(getPreviewRuntimeRunner(sandbox), 'runWaking');

      await sandbox.tunnels.get(8080);

      expect(runWaking).toHaveBeenCalledTimes(1);
      expect(runWaking).toHaveBeenCalledWith(
        'tunnel.provision',
        expect.any(Function)
      );
      const meta = (await storageGet('tunnels:meta')) as Record<
        string,
        Record<string, unknown>
      >;
      expect(meta['8080']?.runtimeIdentityID).toBe('runtime-1');
      expect(meta['8080']?.runtimeIncarnationID).toBe('test-incarnation');
      expect(meta['8080']?.sandboxLifetimeID).toBe('lifetime-1');
    });

    it('destroy() deletes the tunnels storage key', async () => {
      const deletedKeys: string[] = [];
      vi.mocked(mockCtx.storage!.delete).mockImplementation(async (key) => {
        deletedKeys.push(String(key));
        return true;
      });
      vi.spyOn(Container.prototype, 'destroy').mockImplementation(
        async () => {}
      );

      await sandbox.destroy();

      expect(deletedKeys).toContain('tunnels');
    });
  });

  describe('validatePortToken', () => {
    beforeEach(() => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) =>
        key === 'portTokens' ? { '8080': { token: 'correcttoken' } } : null
      );
    });

    it('returns true for a matching token without calling the container', async () => {
      const result = await sandbox.validatePortToken(8080, 'correcttoken');

      expect(result).toBe(true);
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

  describe('getExposedPorts Contract B', () => {
    beforeEach(async () => {
      await sandbox.setSandboxName('test-sandbox');
    });

    it('lists only ports activated for the current runtime without contacting the container', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'portTokens') {
          return {
            '8080': { token: 'tok8080', name: 'api' },
            '9090': { token: 'tok9090' }
          };
        }
        if (key === 'activePreviewPorts') {
          return {
            '8080': {
              runtimeIdentityID: 'runtime-1',
              runtimeIncarnationID: 'test-incarnation',
              token: 'tok8080'
            },
            '9090': {
              runtimeIdentityID: 'runtime-old',
              runtimeIncarnationID: 'test-incarnation',
              token: 'tok9090'
            }
          };
        }
        return null;
      });

      const result = await sandbox.getExposedPorts('example.com');

      expect(result).toEqual([
        {
          url: 'https://8080-test-sandbox-tok8080.example.com/',
          port: 8080,
          status: 'active'
        }
      ]);
    });

    it('returns an empty list when durable auth exists without a current runtime', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return { '8080': { token: 'tok8080' } };
        }
        if (key === 'activePreviewPorts') {
          return {
            '8080': {
              runtimeIdentityID: 'runtime-1',
              runtimeIncarnationID: 'test-incarnation',
              token: 'tok8080'
            }
          };
        }
        return null;
      });

      await expect(sandbox.getExposedPorts('example.com')).resolves.toEqual([]);
    });

    it('omits durable auth without matching current-runtime activation', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'portTokens') {
          return { '8080': { token: 'tok8080' } };
        }
        if (key === 'activePreviewPorts') {
          return {};
        }
        return null;
      });

      await expect(sandbox.getExposedPorts('example.com')).resolves.toEqual([]);
    });
  });

  describe('isPortExposed Contract B', () => {
    beforeEach(() => {});

    it('returns true only for durable auth activated in the current runtime', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'portTokens') {
          return { '8080': { token: 'tok8080' } };
        }
        if (key === 'activePreviewPorts') {
          return {
            '8080': {
              runtimeIdentityID: 'runtime-1',
              runtimeIncarnationID: 'test-incarnation',
              token: 'tok8080'
            }
          };
        }
        return null;
      });

      await expect(sandbox.isPortExposed(8080)).resolves.toBe(true);
    });

    it('returns false for durable auth without activation', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'portTokens') {
          return { '8080': { token: 'tok8080' } };
        }
        if (key === 'activePreviewPorts') {
          return {};
        }
        return null;
      });

      await expect(sandbox.isPortExposed(8080)).resolves.toBe(false);
    });

    it('returns false for activation from an old runtime', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'portTokens') {
          return { '8080': { token: 'tok8080' } };
        }
        if (key === 'activePreviewPorts') {
          return {
            '8080': {
              runtimeIdentityID: 'runtime-old',
              runtimeIncarnationID: 'test-incarnation',
              token: 'tok8080'
            }
          };
        }
        return null;
      });

      await expect(sandbox.isPortExposed(8080)).resolves.toBe(false);
    });
  });

  describe('unexposePort Contract B', () => {
    beforeEach(() => {});

    it('revokes auth and activation without waking when no current runtime is active', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'portTokens') {
          return { '8080': { token: 'tok8080' } };
        }
        if (key === 'activePreviewPorts') {
          return {
            '8080': {
              runtimeIdentityID: 'runtime-1',
              runtimeIncarnationID: 'test-incarnation',
              token: 'tok8080'
            }
          };
        }
        return null;
      });

      await sandbox.unexposePort(8080);

      expect(mockCtx.storage.put).toHaveBeenCalledWith('portTokens', {});
      expect(mockCtx.storage.delete).toHaveBeenCalledWith('activePreviewPorts');
    });

    it('revokes auth and activation without touching the container registry when runtime is active', async () => {
      vi.mocked(mockCtx.storage.get).mockImplementation(async (key) => {
        if (key === 'currentRuntimeIdentity') {
          return runtimeRecord('runtime-1');
        }
        if (key === 'portTokens') {
          return { '8080': { token: 'tok8080' } };
        }
        if (key === 'activePreviewPorts') {
          return {
            '8080': {
              runtimeIdentityID: 'runtime-1',
              runtimeIncarnationID: 'test-incarnation',
              token: 'tok8080'
            }
          };
        }
        return null;
      });

      await sandbox.unexposePort(8080);

      expect(mockCtx.storage.put).toHaveBeenCalledWith('portTokens', {});
      expect(mockCtx.storage.delete).toHaveBeenCalledWith('activePreviewPorts');
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
      await sandbox.setContainerTimeouts(current);
      expect(mockCtx.storage.put.mock.calls.length).toBe(putCallsBefore);
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
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false })
      };
    }

    async function createBackupSandbox(
      bucket = createBackupBucket(),
      env: Record<string, unknown> = {}
    ) {
      const backupSandbox = new Sandbox(
        mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
        {
          BACKUP_BUCKET: bucket,
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          R2_ACCESS_KEY_ID: 'test-key',
          R2_SECRET_ACCESS_KEY: 'test-secret',
          BACKUP_BUCKET_NAME: 'test-backups',
          ...env
        }
      );

      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });
      asSandboxWithClient(backupSandbox as any).client =
        createMockControlClient();
      await (
        mockCtx.storage.put as unknown as (
          key: string,
          value: unknown
        ) => Promise<void>
      )('currentRuntimeIdentity', {
        schemaVersion: 1,
        id: 'runtime-1',
        runtimeIncarnationID: 'incarnation-1'
      });
      const runtimeTarget = backupSandbox as unknown as {
        client: ContainerControlClient;
        runWakingComposite<T>(
          operation: string,
          call: (lease: {
            runtime: { id: string; runtimeIncarnationID: string };
            control: ContainerControlClient;
            retain(): { release(): void };
          }) => Promise<T>
        ): Promise<T>;
      };
      runtimeTarget.runWakingComposite = async (_operation, call) =>
        await call({
          runtime: {
            id: 'runtime-1',
            runtimeIncarnationID: 'incarnation-1'
          },
          control: runtimeTarget.client,
          retain: () => ({ release: () => {} })
        });

      return { backupSandbox, bucket };
    }

    it('should build backup object URLs with the default R2 endpoint', async () => {
      const { backupSandbox } = await createBackupSandbox();

      const url = (
        (backupSandbox as any).backupService.transfer as {
          getBackupObjectURL: (
            accountId: string,
            bucketName: string,
            r2Key: string
          ) => URL;
        }
      ).getBackupObjectURL(
        'test-account',
        'test-backups',
        'backups/id/data.sqsh'
      );

      expect(url.toString()).toBe(
        'https://test-account.r2.cloudflarestorage.com/test-backups/backups/id/data.sqsh'
      );
    });

    it('should build backup object URLs with a custom R2 endpoint', async () => {
      const { backupSandbox } = await createBackupSandbox(
        createBackupBucket(),
        {
          BACKUP_BUCKET_ENDPOINT:
            'https://test-account.eu.r2.cloudflarestorage.com/'
        }
      );

      const url = (
        (backupSandbox as any).backupService.transfer as {
          getBackupObjectURL: (
            accountId: string,
            bucketName: string,
            r2Key: string
          ) => URL;
        }
      ).getBackupObjectURL(
        'test-account',
        'test-backups',
        'backups/id/data.sqsh'
      );

      expect(url.toString()).toBe(
        'https://test-account.eu.r2.cloudflarestorage.com/test-backups/backups/id/data.sqsh'
      );
    });

    it('should throw InvalidBackupConfigError for a malformed BACKUP_BUCKET_ENDPOINT', async () => {
      await expect(
        createBackupSandbox(createBackupBucket(), {
          BACKUP_BUCKET_ENDPOINT: 'not-a-url'
        })
      ).rejects.toThrow(InvalidBackupConfigError);
    });

    it('should throw InvalidBackupConfigError for an http BACKUP_BUCKET_ENDPOINT', async () => {
      await expect(
        createBackupSandbox(createBackupBucket(), {
          BACKUP_BUCKET_ENDPOINT:
            'http://test-account.eu.r2.cloudflarestorage.com'
        })
      ).rejects.toThrow(InvalidBackupConfigError);
    });

    it('should throw InvalidBackupConfigError for a BACKUP_BUCKET_ENDPOINT with a path', async () => {
      await expect(
        createBackupSandbox(createBackupBucket(), {
          BACKUP_BUCKET_ENDPOINT:
            'https://test-account.eu.r2.cloudflarestorage.com/some/prefix'
        })
      ).rejects.toThrow(InvalidBackupConfigError);
    });

    it('should throw InvalidBackupConfigError for a BACKUP_BUCKET_ENDPOINT with a query', async () => {
      await expect(
        createBackupSandbox(createBackupBucket(), {
          BACKUP_BUCKET_ENDPOINT:
            'https://test-account.eu.r2.cloudflarestorage.com?region=eu'
        })
      ).rejects.toThrow(InvalidBackupConfigError);
    });

    it('should throw InvalidBackupConfigError for a BACKUP_BUCKET_ENDPOINT with a fragment', async () => {
      await expect(
        createBackupSandbox(createBackupBucket(), {
          BACKUP_BUCKET_ENDPOINT:
            'https://test-account.eu.r2.cloudflarestorage.com#bucket'
        })
      ).rejects.toThrow(InvalidBackupConfigError);
    });

    it('should allow creating a backup from /app', async () => {
      const { backupSandbox, bucket } = await createBackupSandbox();
      const createArchiveSpy = vi
        .spyOn(
          asSandboxWithClient(backupSandbox as any).client.backup,
          'createArchive'
        )
        .mockResolvedValue({
          success: true,
          sizeBytes: 42,
          archivePath: '/var/backups/mock.sqsh'
        });
      vi.spyOn(
        (backupSandbox as any).backupService.transfer,
        'uploadBackupPresigned'
      ).mockResolvedValue(undefined);

      const backup = await backupSandbox.createBackup({ dir: '/app/project' });

      expect(backup.dir).toBe('/app/project');
      expect(createArchiveSpy).toHaveBeenCalledWith(
        '/app/project',
        expect.stringMatching(/^\/var\/backups\/.+\.sqsh$/),
        {
          gitignore: false,
          excludes: [],
          compression: {
            format: 'lz4',
            threads: 8
          }
        }
      );
      expect(bucket.put).toHaveBeenCalled();
    });

    it('should normalize globstar excludes before calling createArchive', async () => {
      const { backupSandbox } = await createBackupSandbox();
      const createArchiveSpy = vi
        .spyOn(
          asSandboxWithClient(backupSandbox as any).client.backup,
          'createArchive'
        )
        .mockResolvedValue({
          success: true,
          sizeBytes: 42,
          archivePath: '/var/backups/mock.sqsh'
        });
      vi.spyOn(
        (backupSandbox as any).backupService.transfer,
        'uploadBackupPresigned'
      ).mockResolvedValue(undefined);

      await backupSandbox.createBackup({
        dir: '/app/project',
        excludes: ['**/node_modules/.cache', '**/.next/cache', 'dist/**', '**']
      });

      expect(createArchiveSpy).toHaveBeenCalledWith(
        '/app/project',
        expect.stringMatching(/^\/var\/backups\/.+\.sqsh$/),
        {
          gitignore: false,
          excludes: ['node_modules/.cache', '.next/cache', 'dist'],
          compression: {
            format: 'lz4',
            threads: 8
          }
        }
      );
    });

    it('should reject unsupported backup compression before runtime admission', async () => {
      const { backupSandbox } = await createBackupSandbox();
      const runWakingSpy = vi.spyOn(
        backupSandbox as unknown as { runWakingComposite(): Promise<unknown> },
        'runWakingComposite'
      );
      const createArchiveSpy = vi.spyOn(
        asSandboxWithClient(backupSandbox as any).client.backup,
        'createArchive'
      );

      await expect(
        backupSandbox.createBackup({
          dir: '/app/project',
          compression: {
            format: 'brotli' as unknown as 'gzip'
          }
        })
      ).rejects.toThrow(
        /BackupOptions\.compression\.format must be one of: gzip, lz4, zstd/
      );

      expect(runWakingSpy).not.toHaveBeenCalled();
      expect(createArchiveSpy).not.toHaveBeenCalled();
    });

    it('should reject invalid backup compression thread count before calling the container', async () => {
      const { backupSandbox } = await createBackupSandbox();
      const createArchiveSpy = vi.spyOn(
        asSandboxWithClient(backupSandbox as any).client.backup,
        'createArchive'
      );

      await expect(
        backupSandbox.createBackup({
          dir: '/app/project',
          compression: {
            threads: 0
          }
        })
      ).rejects.toThrow(
        /BackupOptions\.compression\.threads must be a positive integer/
      );

      expect(createArchiveSpy).not.toHaveBeenCalled();
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
      const restoreArchiveSpy = vi
        .spyOn(
          asSandboxWithClient(backupSandbox as any).client.backup,
          'restoreArchive'
        )
        .mockResolvedValue({ success: true, dir: '/app/project' });
      const downloadBackupParallelSpy = vi
        .spyOn(
          (backupSandbox as any).backupService.transfer,
          'downloadBackupParallel'
        )
        .mockResolvedValue(undefined);

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
        `/var/backups/${backupId}.sqsh`
      );
      expect(downloadBackupParallelSpy).toHaveBeenCalledWith(
        `/var/backups/${backupId}.sqsh`,
        `backups/${backupId}/data.sqsh`,
        42,
        backupId,
        '/app/project',
        asSandboxWithClient(backupSandbox as any).client
      );
    });

    it('should write parallel restore ranges directly into the temp archive', async () => {
      const { backupSandbox } = await createBackupSandbox();
      const expectedSize = 16 * 1024 * 1024;
      const downloadArchiveSpy = vi.spyOn(
        asSandboxWithClient(backupSandbox as any).client.backup,
        'downloadArchive'
      );
      vi.spyOn(
        (backupSandbox as any).backupService.transfer,
        'generatePresignedGetURL'
      ).mockResolvedValue('https://example.com/archive');

      await (
        backupSandbox as any
      ).backupService.transfer.downloadBackupParallel(
        '/var/backups/test.sqsh',
        'backups/test/data.sqsh',
        expectedSize,
        'test-backup-id',
        '/app/project',
        asSandboxWithClient(backupSandbox as any).client
      );

      expect(downloadArchiveSpy).toHaveBeenCalledWith({
        archivePath: '/var/backups/test.sqsh',
        expectedSize,
        parts: expect.arrayContaining([
          expect.objectContaining({
            url: 'https://example.com/archive',
            offset: 0,
            range: expect.stringMatching(/^bytes=0-/)
          })
        ]),
        timeoutMs: 1_810_000
      });
    });

    it('preserves transport interruption during parallel download', async () => {
      const { backupSandbox } = await createBackupSandbox();
      const interruption = new RPCTransportError({
        code: ErrorCode.RPC_TRANSPORT_ERROR,
        message: 'Transport disposed',
        httpStatus: 503,
        context: {
          kind: 'session_disposed',
          originalMessage: 'Transport disposed',
          errorName: 'Error'
        },
        timestamp: '2026-06-15T12:00:00.000Z'
      });
      vi.spyOn(
        asSandboxWithClient(backupSandbox as any).client.backup,
        'downloadArchive'
      ).mockRejectedValue(interruption);
      vi.spyOn(
        (backupSandbox as any).backupService.transfer,
        'generatePresignedGetURL'
      ).mockResolvedValue('https://example.com/archive');

      await expect(
        (backupSandbox as any).backupService.transfer.downloadBackupParallel(
          '/var/backups/test.sqsh',
          'backups/test/data.sqsh',
          16 * 1024 * 1024,
          'test-backup-id',
          '/app/project',
          asSandboxWithClient(backupSandbox as any).client
        )
      ).rejects.toBe(interruption);
    });

    it('should reject unsupported backup roots before calling the container', async () => {
      const { backupSandbox } = await createBackupSandbox();
      const createArchiveSpy = vi.spyOn(
        asSandboxWithClient(backupSandbox as any).client.backup,
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
      mockCtx.container.running = false;
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
      await vi.waitFor(() => expect(superDestroy.calls()).toBe(1));

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

      await vi.waitFor(() => expect(superDestroy.calls()).toBe(1));
      const firstExpectation = expect(first).rejects.toThrow(
        'container teardown failed'
      );
      const secondExpectation = expect(second).rejects.toThrow(
        'container teardown failed'
      );
      superDestroy.reject(new Error('container teardown failed'));

      await firstExpectation;
      await secondExpectation;
    });

    it('runs a fresh teardown for a later destroy() after the previous one settles', async () => {
      const first = stubSuperDestroy();
      const firstCall = sandbox.destroy();
      await vi.waitFor(() => expect(first.calls()).toBe(1));
      first.resolve();
      await firstCall;

      // Re-stub to track the second teardown independently.
      const second = stubSuperDestroy();
      const secondCall = sandbox.destroy();
      await vi.waitFor(() => expect(second.calls()).toBe(1));
      second.resolve();
      await secondCall;
    });
  });

  describe('mountBucket FUSE verification', () => {
    const mountOptions = {
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET'
      }
    };

    function mockMountScript(result: {
      exitCode: number;
      stdout?: string;
      stderr?: string;
    }) {
      vi.mocked(
        asSandboxWithClient(sandbox).client.mounts.mountS3FSAndVerify
      ).mockResolvedValue({
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
      });
    }

    it('succeeds when the mount script reports the mount is live', async () => {
      mockMountScript({ exitCode: 0 });

      await expect(
        sandbox.mountBucket('my-bucket', '/mnt/data', mountOptions)
      ).resolves.toBeUndefined();
    });

    it('throws when the s3fs parent exits non-zero', async () => {
      mockMountScript({ exitCode: 2, stdout: 'fuse: bad mount point' });

      await expect(
        sandbox.mountBucket('my-bucket', '/mnt/data', mountOptions)
      ).rejects.toThrow('S3FS mount failed: fuse: bad mount point');
    });

    it('throws with the s3fs log tail when the mount never appears', async () => {
      mockMountScript({
        exitCode: 3,
        stdout: '[ERR] check_bucket_access: 403 AccessDenied'
      });

      const err = await sandbox
        .mountBucket('my-bucket', '/mnt/data2', mountOptions)
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/FUSE filesystem never appeared/);
      expect(err!.message).toMatch(/403 AccessDenied/);
      await expect(sandbox.unmountBucket('/mnt/data2')).rejects.toThrow(
        'No active mount found at path: /mnt/data2'
      );
    });

    it('unmounts a late-arriving FUSE mount when the script reports timeout', async () => {
      // Race: the script polls 60x for `mountpoint -q` and exits 3 when none
      // succeed, but s3fs is daemonised and can complete the mount between
      // the last poll and our cleanup. The failure path must unmount that
      // mount instead of leaking it.

      vi.mocked(
        asSandboxWithClient(sandbox).client.mounts.mountS3FSAndVerify
      ).mockResolvedValue({
        success: false,
        exitCode: 3,
        stdout: 'mount took too long',
        stderr: ''
      });

      const err = await sandbox
        .mountBucket('my-bucket', '/mnt/late', mountOptions)
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(
        asSandboxWithClient(sandbox).client.mounts.isMountpoint
      ).toHaveBeenCalledWith('/mnt/late');
      expect(
        asSandboxWithClient(sandbox).client.mounts.unmountFuse
      ).toHaveBeenCalledWith('/mnt/late');
    });

    it('keeps support files when failure cleanup cannot unmount FUSE', async () => {
      vi.mocked(
        asSandboxWithClient(sandbox).client.mounts.mountS3FSAndVerify
      ).mockResolvedValue({
        success: false,
        exitCode: 3,
        stdout: 'mount took too long',
        stderr: ''
      });
      vi.mocked(
        asSandboxWithClient(sandbox).client.mounts.isMountpoint
      ).mockResolvedValue(true);
      vi.mocked(
        asSandboxWithClient(sandbox).client.mounts.unmountFuse
      ).mockResolvedValue({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'device is busy'
      });

      await expect(
        sandbox.mountBucket('my-bucket', '/mnt/busy', mountOptions)
      ).rejects.toThrow(/S3FS mount failed/);

      await expect(sandbox.unmountBucket('/mnt/busy')).rejects.toThrow(
        'No active mount found at path: /mnt/busy'
      );
      expect(
        asSandboxWithClient(sandbox).client.mounts.deleteFile
      ).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Sandbox.getProcess()
// ---------------------------------------------------------------------------
