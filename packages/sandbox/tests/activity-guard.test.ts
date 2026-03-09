import { Container } from '@cloudflare/containers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';

vi.mock('../src/interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({
    runCode: vi.fn(),
    listCodeContexts: vi.fn(),
    deleteCodeContext: vi.fn(),
    createCodeContext: vi.fn()
  }))
}));

vi.mock('@cloudflare/containers', () => {
  const mockSwitchPort = vi.fn((request: Request, port: number) => {
    const url = new URL(request.url);
    url.pathname = `/proxy/${port}${url.pathname}`;
    return new Request(url, request);
  });

  const MockContainer = class Container {
    ctx: unknown;
    env: unknown;
    sleepAfter: string | number = '10m';
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
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
    async containerFetch(_request: Request, _port: number): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }
    async getState() {
      return { status: 'healthy' };
    }
    renewActivityTimeout() {}
    async onActivityExpired(): Promise<void> {}
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
  sql: {
    exec: ReturnType<typeof vi.fn>;
  };
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
  container: {
    running: boolean;
    start: ReturnType<typeof vi.fn>;
    getTcpPort: ReturnType<typeof vi.fn>;
    monitor: ReturnType<typeof vi.fn>;
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function readAllBytes(
  stream: ReadableStream<Uint8Array>
): Promise<number[]> {
  const reader = stream.getReader();
  const out: number[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(...Array.from(value));
  }
  return out;
}

describe('Sandbox activity guard infrastructure', () => {
  let sandbox: Sandbox;
  let mockCtx: MockCtx;
  let superOnActivityExpiredSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map()),
        sql: {
          exec: vi.fn().mockResolvedValue(undefined)
        }
      },
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
      },
      container: {
        running: true,
        start: vi.fn().mockResolvedValue(undefined),
        getTcpPort: vi.fn().mockResolvedValue({
          fetch: vi.fn().mockResolvedValue(new Response('ok'))
        }),
        monitor: vi.fn().mockResolvedValue(undefined)
      }
    };

    const stub = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      {} as ConstructorParameters<typeof Sandbox>[1]
    );

    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    sandbox = stub;
    superOnActivityExpiredSpy = vi
      .spyOn(Container.prototype, 'onActivityExpired')
      .mockResolvedValue(undefined);
  });

  describe('onActivityExpired() guard behavior', () => {
    it('does not call super.onActivityExpired() when activeOperations > 0', async () => {
      sandbox['keepAliveEnabled'] = false;
      sandbox['activeOperations'] = 1;
      sandbox['operationStartTimes'].set(1, Date.now());

      const renewSpy = vi.spyOn(sandbox as unknown as { renewActivityTimeout: () => void }, 'renewActivityTimeout');

      await sandbox.onActivityExpired();

      expect(superOnActivityExpiredSpy).not.toHaveBeenCalled();
      expect(renewSpy).toHaveBeenCalledTimes(1);
    });

    it('calls super.onActivityExpired() when activeOperations is 0 and keepAliveEnabled is false', async () => {
      sandbox['keepAliveEnabled'] = false;
      sandbox['activeOperations'] = 0;
      sandbox['operationStartTimes'].clear();

      await sandbox.onActivityExpired();

      expect(superOnActivityExpiredSpy).toHaveBeenCalledTimes(1);
    });

    it('keepAliveEnabled takes priority and does not call super even when activeOperations is 0', async () => {
      sandbox['keepAliveEnabled'] = true;
      sandbox['activeOperations'] = 0;
      sandbox['operationStartTimes'].clear();

      await sandbox.onActivityExpired();

      expect(superOnActivityExpiredSpy).not.toHaveBeenCalled();
    });

    it('safety valve calls super when all tracked operations exceed 30 minutes', async () => {
      const oldStartTime = Date.now() - 30 * 60 * 1000 - 1;
      sandbox['keepAliveEnabled'] = false;
      sandbox['activeOperations'] = 2;
      sandbox['operationStartTimes'].clear();
      sandbox['operationStartTimes'].set(1, oldStartTime);
      sandbox['operationStartTimes'].set(2, oldStartTime);

      await sandbox.onActivityExpired();

      expect(superOnActivityExpiredSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('withActivityTracking() counter behavior', () => {
    it('increments during execution and decrements after completion', async () => {
      const deferred = createDeferred<void>();
      const withActivityTracking = sandbox['withActivityTracking'].bind(
        sandbox
      ) as <T>(fn: () => Promise<T>) => Promise<T>;

      const pending = withActivityTracking(async () => {
        expect(sandbox['activeOperations']).toBe(1);
        await deferred.promise;
      });

      expect(sandbox['activeOperations']).toBe(1);
      deferred.resolve();
      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });

    it('decrements counter on error via finally', async () => {
      const withActivityTracking = sandbox['withActivityTracking'].bind(
        sandbox
      ) as <T>(fn: () => Promise<T>) => Promise<T>;

      await expect(
        withActivityTracking(async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(sandbox['activeOperations']).toBe(0);
      expect(sandbox['operationStartTimes'].size).toBe(0);
    });

    it('tracks multiple concurrent operations correctly', async () => {
      const one = createDeferred<void>();
      const two = createDeferred<void>();
      const withActivityTracking = sandbox['withActivityTracking'].bind(
        sandbox
      ) as <T>(fn: () => Promise<T>) => Promise<T>;

      const first = withActivityTracking(async () => one.promise);
      const second = withActivityTracking(async () => two.promise);

      expect(sandbox['activeOperations']).toBe(2);
      expect(sandbox['operationStartTimes'].size).toBe(2);

      one.resolve();
      await first;
      expect(sandbox['activeOperations']).toBe(1);

      two.resolve();
      await second;
      expect(sandbox['activeOperations']).toBe(0);
      expect(sandbox['operationStartTimes'].size).toBe(0);
    });
  });

  describe('trackStream() wrapper behavior', () => {
    it('increments counter when stream is wrapped', async () => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        }
      });
      const trackStream = sandbox['trackStream'].bind(sandbox) as (
        stream: ReadableStream<Uint8Array>
      ) => ReadableStream<Uint8Array>;

      const wrapped = trackStream(source);

      expect(sandbox['activeOperations']).toBe(1);
      expect(sandbox['operationStartTimes'].size).toBe(1);
      await wrapped.cancel('cleanup');
    });

    it('decrements counter when wrapped stream completes normally', async () => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        }
      });
      const trackStream = sandbox['trackStream'].bind(sandbox) as (
        stream: ReadableStream<Uint8Array>
      ) => ReadableStream<Uint8Array>;
      const wrapped = trackStream(source);

      await readAllBytes(wrapped);
      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
    });

    it('decrements counter when wrapped stream is cancelled', async () => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([9]));
        }
      });
      const trackStream = sandbox['trackStream'].bind(sandbox) as (
        stream: ReadableStream<Uint8Array>
      ) => ReadableStream<Uint8Array>;
      const wrapped = trackStream(source);
      const reader = wrapped.getReader();

      await reader.cancel('cancelled');

      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
    });

    it('decrements counter when source stream errors', async () => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('stream-failed'));
        }
      });
      const trackStream = sandbox['trackStream'].bind(sandbox) as (
        stream: ReadableStream<Uint8Array>
      ) => ReadableStream<Uint8Array>;
      const wrapped = trackStream(source);

      await expect(wrapped.getReader().read()).rejects.toThrow('stream-failed');
      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
    });

    it("doesn't go negative when cancellation and pipe rejection both occur", async () => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([7]));
        }
      });
      const trackStream = sandbox['trackStream'].bind(sandbox) as (
        stream: ReadableStream<Uint8Array>
      ) => ReadableStream<Uint8Array>;
      const wrapped = trackStream(source);

      expect(sandbox['activeOperations']).toBe(1);
      await wrapped.cancel('stop now');

      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
      expect(sandbox['activeOperations']).toBeGreaterThanOrEqual(0);
    });

    it('passes stream bytes through unchanged', async () => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
          controller.close();
        }
      });
      const trackStream = sandbox['trackStream'].bind(sandbox) as (
        stream: ReadableStream<Uint8Array>
      ) => ReadableStream<Uint8Array>;
      const wrapped = trackStream(source);

      const bytes = await readAllBytes(wrapped);

      expect(bytes).toEqual([1, 2, 3, 4, 5]);
      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
    });
  });

  describe('exec() wiring uses withActivityTracking via execWithSession', () => {
    it('increments activeOperations during exec() and decrements after completion', async () => {
      sandbox['defaultSession'] = 'sandbox-default';
      const deferred = createDeferred<{
        success: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
        command: string;
        timestamp: string;
      }>();

      // Spy on execWithSession to verify single tracking
      const execWithSessionSpy = vi.spyOn(
        sandbox as unknown as {
          execWithSession: (
            command: string,
            sessionId: string,
            options?: unknown
          ) => Promise<unknown>;
        },
        'execWithSession'
      );

      vi.spyOn(sandbox.client.commands, 'execute').mockReturnValue(
        deferred.promise
      );

      const pending = sandbox.exec('echo test');

      // Wait for execWithSession to be called and tracking to start
      await vi.waitFor(() => {
        expect(execWithSessionSpy).toHaveBeenCalled();
      });

      // exec() delegates to execWithSession which handles tracking
      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve({
        success: true,
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        command: 'echo test',
        timestamp: new Date().toISOString()
      });

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });

    it('decrements activeOperations when exec() throws', async () => {
      sandbox['defaultSession'] = 'sandbox-default';
      vi.spyOn(sandbox.client.commands, 'execute').mockRejectedValue(
        new Error('exec failed')
      );

      await expect(sandbox.exec('fail')).rejects.toThrow('exec failed');
      expect(sandbox['activeOperations']).toBe(0);
      expect(sandbox['operationStartTimes'].size).toBe(0);
    });
  });

  describe('writeFile() wiring uses withActivityTracking', () => {
    it('increments activeOperations during writeFile() and decrements after completion', async () => {
      sandbox['defaultSession'] = 'sandbox-default';
      const deferred = createDeferred<{
        success: boolean;
        path: string;
        timestamp: string;
      }>();

      vi.spyOn(sandbox.client.files, 'writeFile').mockReturnValue(
        deferred.promise
      );

      const pending = sandbox.writeFile('/workspace/a.txt', 'hello');

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve({
        success: true,
        path: '/workspace/a.txt',
        timestamp: new Date().toISOString()
      });

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });

    it('decrements activeOperations when writeFile() throws', async () => {
      sandbox['defaultSession'] = 'sandbox-default';
      vi.spyOn(sandbox.client.files, 'writeFile').mockRejectedValue(
        new Error('write failed')
      );

      await expect(
        sandbox.writeFile('/workspace/a.txt', 'hello')
      ).rejects.toThrow('write failed');

      expect(sandbox['activeOperations']).toBe(0);
      expect(sandbox['operationStartTimes'].size).toBe(0);
    });
  });

  describe('startProcessCallbackStream wiring tracks independently', () => {
    it('keeps operation tracked after startProcess() returns when callback stream is pending', async () => {
      sandbox['defaultSession'] = 'sandbox-default';

      vi.spyOn(sandbox.client.processes, 'startProcess').mockResolvedValue({
        success: true,
        processId: 'proc-1',
        pid: 123,
        command: 'npm run dev',
        timestamp: new Date().toISOString()
      });

      const streamDeferred = createDeferred<ReadableStream<Uint8Array>>();
      vi.spyOn(sandbox.client.processes, 'streamProcessLogs').mockReturnValue(
        streamDeferred.promise
      );

      const onOutput = vi.fn();
      const onError = vi.fn();

      await sandbox.startProcess('npm run dev', { onOutput, onError });

      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBeGreaterThan(0);
      });

      streamDeferred.reject(new Error('stream failed'));

      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
      expect(onError).toHaveBeenCalled();
    });
  });

  describe('execStream() wiring returns tracked stream', () => {
    it('tracks stream lifecycle from execStream() until stream completion', async () => {
      sandbox['defaultSession'] = 'sandbox-default';

      let sourceController: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          sourceController = controller;
          controller.enqueue(new Uint8Array([101, 102, 103]));
        }
      });

      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(
        source
      );

      const wrapped = await sandbox.execStream('echo hello');

      expect(sandbox['activeOperations']).toBe(1);

      sourceController!.close();
      const bytes = await readAllBytes(wrapped);

      expect(bytes).toEqual([101, 102, 103]);
      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
    });

    it('decrements activeOperations when tracked execStream() is cancelled', async () => {
      sandbox['defaultSession'] = 'sandbox-default';

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        }
      });

      vi.spyOn(sandbox.client.commands, 'executeStream').mockResolvedValue(
        source
      );

      const wrapped = await sandbox.execStream('echo cancel');
      expect(sandbox['activeOperations']).toBe(1);

      await wrapped.cancel('stop');

      await vi.waitFor(() => {
        expect(sandbox['activeOperations']).toBe(0);
      });
    });
  });

  describe('session.exec() wiring uses withActivityTracking via execWithSession', () => {
    it('increments activeOperations during session.exec() and decrements after completion', async () => {
      const session = sandbox['getSessionWrapper']('test-session');
      const deferred = createDeferred<{
        success: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
        command: string;
        timestamp: string;
      }>();

      vi.spyOn(sandbox.client.commands, 'execute').mockReturnValue(
        deferred.promise
      );

      const pending = session.exec('echo from-session');

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve({
        success: true,
        stdout: 'from-session',
        stderr: '',
        exitCode: 0,
        command: 'echo from-session',
        timestamp: new Date().toISOString()
      });

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });

    it('decrements activeOperations when session.exec() throws', async () => {
      const session = sandbox['getSessionWrapper']('test-session');
      vi.spyOn(sandbox.client.commands, 'execute').mockRejectedValue(
        new Error('session exec failed')
      );

      await expect(session.exec('fail')).rejects.toThrow('session exec failed');
      expect(sandbox['activeOperations']).toBe(0);
      expect(sandbox['operationStartTimes'].size).toBe(0);
    });
  });

  describe('killAllProcesses() wiring uses withActivityTracking', () => {
    it('increments activeOperations during killAllProcesses() and decrements after completion', async () => {
      const deferred = createDeferred<{
        success: boolean;
        cleanedCount: number;
        timestamp: string;
      }>();

      vi.spyOn(sandbox.client.processes, 'killAllProcesses').mockReturnValue(
        deferred.promise
      );

      const pending = sandbox.killAllProcesses();

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve({
        success: true,
        cleanedCount: 3,
        timestamp: new Date().toISOString()
      });

      const result = await pending;
      expect(result).toBe(3);
      expect(sandbox['activeOperations']).toBe(0);
    });
  });

  describe('session.listFiles() routes through tracked this.listFiles()', () => {
    it('increments activeOperations during session.listFiles() and decrements after completion', async () => {
      sandbox['defaultSession'] = 'sandbox-default';
      const session = sandbox['getSessionWrapper']('test-session');
      const deferred = createDeferred<{
        success: boolean;
        path: string;
        files: [];
        count: number;
        timestamp: string;
      }>();

      vi.spyOn(sandbox.client.files, 'listFiles').mockReturnValue(
        deferred.promise
      );

      const pending = session.listFiles('/workspace');

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve({
        success: true,
        path: '/workspace',
        files: [],
        count: 0,
        timestamp: new Date().toISOString()
      });

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });
  });

  describe('session.setEnvVars() routes through setEnvVarsWithSession', () => {
    it('increments activeOperations during session.setEnvVars() and decrements after completion', async () => {
      const session = sandbox['getSessionWrapper']('test-session');
      const deferred = createDeferred<{
        success: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
        command: string;
        timestamp: string;
      }>();

      vi.spyOn(sandbox.client.commands, 'execute').mockReturnValue(
        deferred.promise
      );

      const pending = session.setEnvVars({ FOO: 'bar' });

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        command: 'export FOO=bar',
        timestamp: new Date().toISOString()
      });

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });

    it('decrements activeOperations when session.setEnvVars() throws', async () => {
      const session = sandbox['getSessionWrapper']('test-session');
      vi.spyOn(sandbox.client.commands, 'execute').mockRejectedValue(
        new Error('env set failed')
      );

      await expect(session.setEnvVars({ FOO: 'bar' })).rejects.toThrow(
        'env set failed'
      );
      expect(sandbox['activeOperations']).toBe(0);
      expect(sandbox['operationStartTimes'].size).toBe(0);
    });
  });

  describe('session code interpreter methods route through tracked sandbox methods', () => {
    it('session.runCode() increments and decrements activeOperations', async () => {
      const session = sandbox['getSessionWrapper']('test-session');
      const deferred = createDeferred<unknown>();

      vi.spyOn(sandbox['codeInterpreter'], 'runCode').mockReturnValue(
        deferred.promise as ReturnType<
          (typeof sandbox)['codeInterpreter']['runCode']
        >
      );

      const pending = session.runCode('print("hello")');

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve({
        toJSON: () => ({
          code: '',
          results: [],
          logs: { stdout: [], stderr: [] }
        })
      });

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });

    it('session.listCodeContexts() increments and decrements activeOperations', async () => {
      const session = sandbox['getSessionWrapper']('test-session');
      const deferred = createDeferred<[]>();

      vi.spyOn(sandbox['codeInterpreter'], 'listCodeContexts').mockReturnValue(
        deferred.promise
      );

      const pending = session.listCodeContexts();

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve([]);

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });

    it('session.deleteCodeContext() increments and decrements activeOperations', async () => {
      const session = sandbox['getSessionWrapper']('test-session');
      const deferred = createDeferred<void>();

      vi.spyOn(sandbox['codeInterpreter'], 'deleteCodeContext').mockReturnValue(
        deferred.promise
      );

      const pending = session.deleteCodeContext('ctx-1');

      expect(sandbox['activeOperations']).toBe(1);

      deferred.resolve();

      await pending;
      expect(sandbox['activeOperations']).toBe(0);
    });
  });
});
