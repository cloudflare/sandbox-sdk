/**
 * Tests for `GET /v1/rpc` — the bridge's capnweb WebSocket RPC endpoint.
 *
 * The endpoint is sandbox-agnostic: clients open one socket, then call
 * `rpc.sandbox(id)` to address a specific sandbox. Pool resolution
 * happens inside that RPC call, not in HTTP middleware.
 *
 * Tests drive `handleRpcUpgrade()` directly (no Hono routing involved)
 * and exercise the full `BridgeRPCAPI` -> `SandboxRPCAPI` shape over a
 * real in-process WebSocket pair.
 */

import type {
  RpcSession as CapnwebRpcSession,
  RpcStub,
  RpcTransport
} from 'capnweb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX } from '../src/bridge';
import { handleRpcUpgrade } from '../src/bridge/rpc-api';
import { createMockEnv, createMockSandbox } from './bridge-test-helpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSandbox = createMockSandbox();

vi.mock('../src/bridge/bridge-sandbox', async () => {
  const actual = await vi.importActual<
    typeof import('../src/bridge/bridge-sandbox')
  >('../src/bridge/bridge-sandbox');
  return {
    ...actual,
    getBridgeSandbox: vi.fn(() => mockSandbox)
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBPROTOCOL_PREFIX = BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX;
const RPC_URL = 'http://localhost/v1/rpc';

interface CallOptions {
  headers?: Record<string, string>;
  envOverride?: Record<string, unknown>;
}

/** Issue a single request to `handleRpcUpgrade` and return the Response. */
function callRpc(opts: CallOptions = {}): Response {
  const env = (opts.envOverride ?? createMockEnv()) as Parameters<
    typeof handleRpcUpgrade
  >[1];
  const request = new Request(RPC_URL, {
    method: 'GET',
    headers: opts.headers
  });
  return handleRpcUpgrade(request, env, { sandboxBinding: 'Sandbox' });
}

/** Issue a WS-upgrade request that returns an upgraded response. */
function callRpcWs(opts: CallOptions = {}): Response {
  return callRpc({
    ...opts,
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      ...(opts.headers ?? {})
    }
  });
}

/**
 * Adapt a Workers WebSocket into a capnweb `RpcTransport`. Mirrors what
 * `newWebSocketRpcSession()` does internally but kept inline so the test
 * doesn't pull in browser-specific helpers.
 */
function makeWsTransport(ws: WebSocket): RpcTransport {
  let onMessage: ((data: string) => void) | null = null;
  let onClose: ((err?: Error) => void) | null = null;
  ws.addEventListener('message', (e: MessageEvent) => {
    if (typeof e.data === 'string') onMessage?.(e.data);
  });
  ws.addEventListener('close', () => onClose?.());
  ws.addEventListener('error', () => onClose?.(new Error('socket error')));
  return {
    async send(message: string) {
      ws.send(message);
    },
    async receive() {
      return new Promise<string>((resolve, reject) => {
        onMessage = (data) => {
          onMessage = null;
          resolve(data);
        };
        onClose = (err) => {
          onClose = null;
          reject(err ?? new Error('closed'));
        };
      });
    }
  };
}

/** Open an RPC capnweb session against `handleRpcUpgrade`. */
async function connect<T extends object>(
  opts: CallOptions = {}
): Promise<{
  stub: RpcStub<T>;
  ws: WebSocket;
  session: CapnwebRpcSession<T>;
}> {
  const { RpcSession } = await import('capnweb');
  const res = callRpcWs(opts);
  if (res.status !== 101) {
    throw new Error(`expected 101 upgrade, got ${res.status}`);
  }
  const ws = (res as any).webSocket as WebSocket | undefined;
  if (!ws) throw new Error('upgrade did not produce a WebSocket');
  ws.accept();
  const session = new RpcSession<T>(makeWsTransport(ws));
  return { stub: session.getRemoteMain(), ws, session };
}

/**
 * Convenience: open a session, resolve a sandbox stub via `rpc.sandbox(id)`,
 * and return both. Most per-domain tests start here.
 */
async function connectSandbox<TSandbox extends object>(
  sandboxId: string = 'test',
  opts: CallOptions = {}
): Promise<{ sandbox: TSandbox; ws: WebSocket }> {
  type Bridge = { sandbox(id: string): Promise<TSandbox> };
  const { stub, ws } = await connect<Bridge>(opts);
  const sandbox = (await stub.sandbox(sandboxId)) as unknown as TSandbox;
  return { sandbox, ws };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/rpc - capnweb RPC endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('upgrade requirement', () => {
    it('rejects request without Upgrade header with 400', async () => {
      const res = callRpc();
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.error).toBe('WebSocket upgrade required');
      expect(body.code).toBe('invalid_request');
    });
  });

  describe('subprotocol auth', () => {
    const TOKEN = 'secret-token';
    const authedEnv = createMockEnv({ SANDBOX_API_KEY: TOKEN });

    it('returns 401 when Sec-WebSocket-Protocol is missing and a token is configured', async () => {
      const res = callRpcWs({ envOverride: authedEnv });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('unauthorized');
    });

    it('returns 401 when the subprotocol carries the wrong token', async () => {
      const res = callRpcWs({
        envOverride: authedEnv,
        headers: {
          'Sec-WebSocket-Protocol': `${SUBPROTOCOL_PREFIX}WRONG`
        }
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when the subprotocol header is unrelated', async () => {
      const res = callRpcWs({
        envOverride: authedEnv,
        headers: { 'Sec-WebSocket-Protocol': 'graphql-ws' }
      });
      expect(res.status).toBe(401);
    });

    it('accepts the upgrade and echoes the subprotocol when the token is correct', async () => {
      const res = callRpcWs({
        envOverride: authedEnv,
        headers: {
          'Sec-WebSocket-Protocol': `${SUBPROTOCOL_PREFIX}${TOKEN}`
        }
      });
      expect([101, 200]).toContain(res.status);
      expect(res.headers.get('Sec-WebSocket-Protocol')).toBe(
        `${SUBPROTOCOL_PREFIX}${TOKEN}`
      );
    });

    it('accepts the upgrade with no subprotocol when SANDBOX_API_KEY is unset', async () => {
      const res = callRpcWs(); // env has empty SANDBOX_API_KEY
      expect([101, 200]).toContain(res.status);
    });
  });

  describe('capnweb handshake + sandbox(id)', () => {
    it('rpc.sandbox(id) returns a stub that completes a round-trip call', async () => {
      const { sandbox, ws } = await connectSandbox<{
        utils: { ping(): Promise<string> };
      }>();
      try {
        const reply = await sandbox.utils.ping();
        expect(reply).toBe('pong');
      } finally {
        ws.close();
      }
    });

    it('rpc.sandbox(id) rejects an invalid id format', async () => {
      const { stub, ws } = await connect<{
        sandbox(id: string): Promise<unknown>;
      }>();
      try {
        await expect(stub.sandbox('Bad ID!')).rejects.toThrow(
          /Invalid sandbox ID format/i
        );
      } finally {
        ws.close();
      }
    });

    it('rpc.sandbox() generates a fresh id when none is supplied', async () => {
      const { stub, ws } = await connect<{
        sandbox(id?: string): Promise<{ id: string }>;
      }>();
      try {
        const sb = await stub.sandbox();
        const id = await sb.id;
        expect(typeof id).toBe('string');
        expect(id).toMatch(/^[a-z2-7]{1,128}$/);
      } finally {
        ws.close();
      }
    });

    it('rpc.sandbox(id) round-trips the supplied id back through .id', async () => {
      const { stub, ws } = await connect<{
        sandbox(id?: string): Promise<{ id: string }>;
      }>();
      try {
        const sb = await stub.sandbox('mysandbox');
        expect(await sb.id).toBe('mysandbox');
      } finally {
        ws.close();
      }
    });
  });

  describe('commands shim', () => {
    it('forwards commands.execute through getSession(...).exec', async () => {
      const sessionExec = vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: 'hi',
        stderr: '',
        command: 'echo hi',
        timestamp: '2025-01-01T00:00:00Z'
      }));
      mockSandbox.getSession.mockResolvedValue({
        id: 'sess-1',
        exec: sessionExec
      });

      const { sandbox, ws } = await connectSandbox<{
        commands: {
          execute(
            command: string,
            sessionId: string,
            options?: {
              timeoutMs?: number;
              env?: Record<string, string | undefined>;
              cwd?: string;
            }
          ): Promise<{ exitCode: number; stdout: string }>;
        };
      }>();
      try {
        const result = await sandbox.commands.execute('echo hi', 'sess-1', {
          timeoutMs: 5_000,
          cwd: '/workspace',
          env: { FOO: 'bar' }
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('hi');
        expect(mockSandbox.getSession).toHaveBeenCalledWith('sess-1');
        const [cmd, opts] = sessionExec.mock.calls[0] as unknown as [
          string,
          Record<string, unknown>
        ];
        expect(cmd).toBe('echo hi');
        expect(opts).toMatchObject({
          timeout: 5_000,
          cwd: '/workspace',
          env: { FOO: 'bar' }
        });
      } finally {
        ws.close();
      }
    });

    it('forwards commands.executeStream through getSession(...).execStream', async () => {
      const encoder = new TextEncoder();
      const sourceStream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of [
            { type: 'start', timestamp: 't0', command: 'echo hi' },
            { type: 'stdout', timestamp: 't1', data: 'hi\n' },
            { type: 'complete', timestamp: 't2', exitCode: 0 }
          ]) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          }
          controller.close();
        }
      });
      const sessionExecStream = vi.fn(async () => sourceStream);
      mockSandbox.getSession.mockResolvedValue({
        id: 'sess-1',
        execStream: sessionExecStream
      });

      const { sandbox, ws } = await connectSandbox<{
        commands: {
          executeStream(
            command: string,
            sessionId: string,
            options?: { timeoutMs?: number }
          ): Promise<ReadableStream<Uint8Array>>;
        };
      }>();
      try {
        const remote = await sandbox.commands.executeStream(
          'echo hi',
          'sess-1',
          { timeoutMs: 5_000 }
        );
        expect(remote).toBeInstanceOf(ReadableStream);
        const decoder = new TextDecoder();
        let received = '';
        const reader = remote.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
        received += decoder.decode();
        expect(received).toContain('"type":"start"');
        expect(received).toContain('"type":"stdout"');
        expect(received).toContain('"type":"complete"');
      } finally {
        ws.close();
      }
    });
  });

  describe('files shim', () => {
    function mockSessionMethod<K extends string>(
      name: K,
      impl: (...args: any[]) => any
    ) {
      const spy = vi.fn(impl);
      mockSandbox.getSession.mockResolvedValue({ id: 'sess-1', [name]: spy });
      return spy;
    }

    it('readFile forwards path + options through the session', async () => {
      const spy = mockSessionMethod('readFile', async () => ({
        success: true,
        content: 'hello',
        path: '/x.txt',
        timestamp: 't'
      }));
      const { sandbox, ws } = await connectSandbox<{
        files: {
          readFile(
            p: string,
            sid: string,
            o?: { encoding?: string }
          ): Promise<{ content: string }>;
        };
      }>();
      try {
        const r = await sandbox.files.readFile('/x.txt', 'sess-1', {
          encoding: 'utf-8'
        });
        expect(r.content).toBe('hello');
        expect(spy).toHaveBeenCalledWith('/x.txt', { encoding: 'utf-8' });
      } finally {
        ws.close();
      }
    });

    it('writeFile forwards content + options', async () => {
      const spy = mockSessionMethod('writeFile', async () => ({
        success: true,
        path: '/x.txt',
        timestamp: 't'
      }));
      const { sandbox, ws } = await connectSandbox<{
        files: {
          writeFile(
            p: string,
            c: string,
            sid: string,
            o?: { encoding?: string }
          ): Promise<{ success: boolean }>;
        };
      }>();
      try {
        const r = await sandbox.files.writeFile('/x.txt', 'hi', 'sess-1', {
          encoding: 'utf-8'
        });
        expect(r.success).toBe(true);
        expect(spy).toHaveBeenCalledWith('/x.txt', 'hi', { encoding: 'utf-8' });
      } finally {
        ws.close();
      }
    });

    it('deleteFile forwards path', async () => {
      const spy = mockSessionMethod('deleteFile', async () => ({
        success: true,
        path: '/x.txt',
        timestamp: 't'
      }));
      const { sandbox, ws } = await connectSandbox<{
        files: {
          deleteFile(p: string, sid: string): Promise<{ success: boolean }>;
        };
      }>();
      try {
        const r = await sandbox.files.deleteFile('/x.txt', 'sess-1');
        expect(r.success).toBe(true);
        expect(spy).toHaveBeenCalledWith('/x.txt');
      } finally {
        ws.close();
      }
    });

    it('listFiles forwards options', async () => {
      const spy = mockSessionMethod('listFiles', async () => ({
        success: true,
        path: '/d',
        files: [],
        timestamp: 't'
      }));
      const { sandbox, ws } = await connectSandbox<{
        files: {
          listFiles(
            p: string,
            sid: string,
            o?: { recursive?: boolean }
          ): Promise<{ success: boolean }>;
        };
      }>();
      try {
        await sandbox.files.listFiles('/d', 'sess-1', { recursive: true });
        expect(spy).toHaveBeenCalledWith('/d', { recursive: true });
      } finally {
        ws.close();
      }
    });
  });

  describe('processes shim', () => {
    function mockSandboxMethod<K extends string>(
      name: K,
      impl: (...args: any[]) => any
    ) {
      const spy = vi.fn(impl);
      (mockSandbox as any)[name] = spy;
      return spy;
    }

    it('startProcess forwards through getSession + flattens', async () => {
      const sessionStartProcess = vi.fn(async () => ({
        id: 'p1',
        pid: 4242,
        command: 'sleep 1',
        status: 'running',
        startTime: new Date('2025-01-01T00:00:00Z')
      }));
      mockSandbox.getSession.mockResolvedValue({
        id: 'sess-1',
        startProcess: sessionStartProcess
      });

      const { sandbox, ws } = await connectSandbox<{
        processes: {
          startProcess(
            cmd: string,
            sid: string,
            opts?: { processId?: string; timeoutMs?: number }
          ): Promise<{ processId: string; pid?: number }>;
        };
      }>();
      try {
        const r = await sandbox.processes.startProcess('sleep 1', 'sess-1', {
          processId: 'p1',
          timeoutMs: 1000
        });
        expect(r).toMatchObject({ processId: 'p1', pid: 4242 });
        const [cmd, opts] = sessionStartProcess.mock.calls[0] as unknown as [
          string,
          Record<string, unknown>
        ];
        expect(cmd).toBe('sleep 1');
        expect(opts).toMatchObject({ processId: 'p1', timeout: 1000 });
      } finally {
        ws.close();
      }
    });

    it('listProcesses + getProcess + killProcess + getProcessLogs + streamProcessLogs forward', async () => {
      const list = mockSandboxMethod('listProcesses', async () => [
        {
          id: 'p1',
          command: 'a',
          status: 'running',
          startTime: new Date('2025-01-01T00:00:00Z')
        }
      ]);
      const get = mockSandboxMethod('getProcess', async () => ({
        id: 'p1',
        command: 'a',
        status: 'running',
        startTime: new Date('2025-01-01T00:00:00Z')
      }));
      const kill = mockSandboxMethod('killProcess', async () => undefined);
      const killAll = mockSandboxMethod('killAllProcesses', async () => 3);
      const logs = mockSandboxMethod('getProcessLogs', async () => ({
        stdout: 'o',
        stderr: 'e',
        processId: 'p1'
      }));
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        }
      });
      const streamLogs = mockSandboxMethod(
        'streamProcessLogs',
        async () => stream
      );

      const { sandbox, ws } = await connectSandbox<{
        processes: {
          listProcesses(): Promise<{ processes: Array<{ id: string }> }>;
          getProcess(id: string): Promise<{ process: { id: string } }>;
          killProcess(id: string): Promise<{ success: boolean }>;
          killAllProcesses(): Promise<{ cleanedCount: number }>;
          getProcessLogs(id: string): Promise<{ stdout: string }>;
          streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;
        };
      }>();
      try {
        expect((await sandbox.processes.listProcesses()).processes[0].id).toBe(
          'p1'
        );
        expect((await sandbox.processes.getProcess('p1')).process.id).toBe(
          'p1'
        );
        expect((await sandbox.processes.killProcess('p1')).success).toBe(true);
        expect((await sandbox.processes.killAllProcesses()).cleanedCount).toBe(
          3
        );
        expect((await sandbox.processes.getProcessLogs('p1')).stdout).toBe('o');
        expect(await sandbox.processes.streamProcessLogs('p1')).toBeInstanceOf(
          ReadableStream
        );
        for (const spy of [list, get, kill, killAll, logs, streamLogs]) {
          expect(spy).toHaveBeenCalled();
        }
      } finally {
        ws.close();
      }
    });
  });

  describe('ports shim', () => {
    function mockSandboxMethod<K extends string>(
      name: K,
      impl: (...args: any[]) => any
    ) {
      const spy = vi.fn(impl);
      (mockSandbox as any)[name] = spy;
      return spy;
    }

    it('exposePort injects the captured hostname', async () => {
      const spy = mockSandboxMethod('exposePort', async () => ({
        success: true,
        port: 8080,
        url: 'https://8080-abc.example.com',
        timestamp: 't'
      }));
      const { sandbox, ws } = await connectSandbox<{
        ports: {
          exposePort(
            p: number,
            sid: string,
            n?: string
          ): Promise<{ port: number; url: string }>;
        };
      }>();
      try {
        const r = await sandbox.ports.exposePort(8080, 'sess-1', 'web');
        expect(r.port).toBe(8080);
        const [port, opts] = spy.mock.calls[0] as unknown as [
          number,
          Record<string, unknown>
        ];
        expect(port).toBe(8080);
        expect(opts).toMatchObject({ name: 'web' });
        expect(typeof opts.hostname).toBe('string');
      } finally {
        ws.close();
      }
    });

    it('unexposePort + getExposedPorts + watchPort forward', async () => {
      mockSandboxMethod('unexposePort', async () => undefined);
      mockSandboxMethod('getExposedPorts', async () => [
        { port: 8080, url: 'https://8080-x.example.com' }
      ]);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        }
      });
      // watchPort lives on sandbox.client.ports, not on sandbox.
      (mockSandbox as any).client = {
        ...((mockSandbox as any).client ?? {}),
        ports: { watchPort: vi.fn(async () => stream) }
      };

      const { sandbox, ws } = await connectSandbox<{
        ports: {
          unexposePort(
            p: number,
            sid: string
          ): Promise<{ success: boolean; port: number }>;
          getExposedPorts(
            sid: string
          ): Promise<{ ports: Array<{ port: number }> }>;
          watchPort(req: {
            port: number;
            mode: 'http' | 'tcp';
          }): Promise<ReadableStream<Uint8Array>>;
        };
      }>();
      try {
        expect((await sandbox.ports.unexposePort(8080, 'sess-1')).port).toBe(
          8080
        );
        expect(
          (await sandbox.ports.getExposedPorts('sess-1')).ports[0].port
        ).toBe(8080);
        expect(
          await sandbox.ports.watchPort({ port: 8080, mode: 'http' })
        ).toBeInstanceOf(ReadableStream);
      } finally {
        ws.close();
      }
    });
  });

  describe('git/utils/backup/interpreter/desktop/watch shims', () => {
    it('git.checkout forwards through sandbox.gitCheckout', async () => {
      const spy = vi.fn(async () => ({
        success: true,
        repoUrl: 'https://example/r.git',
        branch: 'main',
        targetDir: '/workspace/r',
        timestamp: 't'
      }));
      (mockSandbox as any).gitCheckout = spy;

      const { sandbox, ws } = await connectSandbox<{
        git: {
          checkout(
            url: string,
            sid: string,
            opts?: { branch?: string; timeoutMs?: number }
          ): Promise<{ success: boolean }>;
        };
      }>();
      try {
        await sandbox.git.checkout('https://example/r.git', 'sess-1', {
          branch: 'main',
          timeoutMs: 60_000
        });
        const [repoUrl, opts] = spy.mock.calls[0] as unknown as [
          string,
          Record<string, unknown>
        ];
        expect(repoUrl).toBe('https://example/r.git');
        expect(opts).toMatchObject({
          sessionId: 'sess-1',
          branch: 'main',
          cloneTimeoutMs: 60_000
        });
      } finally {
        ws.close();
      }
    });

    it('utils.ping returns "pong" without touching the client', async () => {
      const { sandbox, ws } = await connectSandbox<{
        utils: { ping(): Promise<string> };
      }>();
      try {
        expect(await sandbox.utils.ping()).toBe('pong');
      } finally {
        ws.close();
      }
    });

    it('utils + backup + interpreter delegate to sandbox.client', async () => {
      const utilsSpies = {
        getVersion: vi.fn(async () => '0.0.0-test'),
        getCommands: vi.fn(async () => ['ls']),
        createSession: vi.fn(async () => ({
          success: true,
          id: 'sess-2',
          message: 'created',
          timestamp: 't'
        })),
        deleteSession: vi.fn(async () => ({
          success: true,
          sessionId: 'sess-2',
          timestamp: 't'
        })),
        listSessions: vi.fn(async () => ({ sessions: ['sess-1'] }))
      };
      const backupSpies = {
        createArchive: vi.fn(async () => ({
          success: true,
          archivePath: '/tmp/a.tar',
          bytes: 0,
          timestamp: 't'
        })),
        restoreArchive: vi.fn(async () => ({ success: true, timestamp: 't' }))
      };
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        }
      });
      const interpreterSpies = {
        createCodeContext: vi.fn(async () => ({
          id: 'ctx-1',
          language: 'python',
          cwd: '/'
        })),
        streamCode: vi.fn(async () => stream),
        runCodeStream: vi.fn(
          async (_ctx: unknown, _code: unknown, _lang: unknown, cbs: any) => {
            await cbs.onStdout?.({ line: 'x' });
          }
        ),
        listCodeContexts: vi.fn(async () => [
          { id: 'ctx-1', language: 'python', cwd: '/' }
        ]),
        deleteCodeContext: vi.fn(async () => undefined)
      };

      (mockSandbox as any).client = {
        utils: utilsSpies,
        backup: backupSpies,
        interpreter: interpreterSpies
      };

      const { sandbox, ws } = await connectSandbox<{
        utils: {
          getVersion(): Promise<string>;
          getCommands(): Promise<string[]>;
          createSession(o: { id: string }): Promise<{ id: string }>;
          deleteSession(id: string): Promise<{ success: boolean }>;
          listSessions(): Promise<{ sessions: string[] }>;
        };
        backup: {
          createArchive(
            d: string,
            a: string,
            sid: string
          ): Promise<{ archivePath: string }>;
          restoreArchive(
            d: string,
            a: string,
            sid: string
          ): Promise<{ success: boolean }>;
        };
        interpreter: {
          createCodeContext(o?: { language?: string }): Promise<{ id: string }>;
          streamCode(
            ctx: string,
            code: string,
            lang?: string
          ): Promise<ReadableStream<Uint8Array>>;
          runCodeStream(
            ctx: string | undefined,
            code: string,
            lang: string | undefined,
            cbs: { onStdout?: (m: { line: string }) => void },
            timeoutMs?: number
          ): Promise<void>;
          listCodeContexts(): Promise<Array<{ id: string }>>;
          deleteCodeContext(id: string): Promise<void>;
        };
      }>();

      try {
        expect(await sandbox.utils.getVersion()).toBe('0.0.0-test');
        expect(await sandbox.utils.getCommands()).toEqual(['ls']);
        expect((await sandbox.utils.createSession({ id: 'sess-2' })).id).toBe(
          'sess-2'
        );
        expect((await sandbox.utils.deleteSession('sess-2')).success).toBe(
          true
        );
        expect((await sandbox.utils.listSessions()).sessions).toEqual([
          'sess-1'
        ]);

        expect(
          (
            await sandbox.backup.createArchive(
              '/workspace',
              '/tmp/a.tar',
              'sess-1'
            )
          ).archivePath
        ).toBe('/tmp/a.tar');
        expect(
          (
            await sandbox.backup.restoreArchive(
              '/workspace',
              '/tmp/a.tar',
              'sess-1'
            )
          ).success
        ).toBe(true);

        expect(
          (await sandbox.interpreter.createCodeContext({ language: 'python' }))
            .id
        ).toBe('ctx-1');
        expect(
          await sandbox.interpreter.streamCode('ctx-1', 'print(1)', 'python')
        ).toBeInstanceOf(ReadableStream);

        const stdoutCalls: unknown[] = [];
        await sandbox.interpreter.runCodeStream(
          'ctx-1',
          'print(1)',
          'python',
          {
            onStdout: (m) => {
              stdoutCalls.push(m);
            }
          },
          1000
        );
        expect(stdoutCalls).toEqual([{ line: 'x' }]);

        expect(
          (await sandbox.interpreter.listCodeContexts()).map((c) => c.id)
        ).toEqual(['ctx-1']);
        await sandbox.interpreter.deleteCodeContext('ctx-1');
        expect(interpreterSpies.deleteCodeContext).toHaveBeenCalledWith(
          'ctx-1'
        );
      } finally {
        ws.close();
      }
    });

    it('watch + checkChanges forward through sandbox', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        }
      });
      const watchSpy = vi.fn(async () => stream);
      const checkSpy = vi.fn(async () => ({
        success: true,
        version: 'v2',
        unchanged: false,
        timestamp: 't'
      }));
      (mockSandbox as any).watch = watchSpy;
      (mockSandbox as any).checkChanges = checkSpy;

      const { sandbox, ws } = await connectSandbox<{
        watch: {
          watch(req: {
            path: string;
            sessionId?: string;
          }): Promise<ReadableStream<Uint8Array>>;
          checkChanges(req: {
            path: string;
            since?: string;
          }): Promise<{ version: string }>;
        };
      }>();
      try {
        await sandbox.watch.watch({ path: '/workspace', sessionId: 'sess-1' });
        const [path, opts] = watchSpy.mock.calls[0] as unknown as [
          string,
          Record<string, unknown>
        ];
        expect(path).toBe('/workspace');
        expect(opts).toMatchObject({ sessionId: 'sess-1' });

        const r = await sandbox.watch.checkChanges({
          path: '/workspace',
          since: 'v1'
        });
        expect(r.version).toBe('v2');
      } finally {
        ws.close();
      }
    });

    it('every desktop method forwards arguments verbatim', async () => {
      const DESKTOP_METHODS = [
        'start',
        'stop',
        'status',
        'screenshot',
        'screenshotRegion',
        'click',
        'doubleClick',
        'tripleClick',
        'rightClick',
        'middleClick',
        'mouseDown',
        'mouseUp',
        'moveMouse',
        'drag',
        'scroll',
        'getCursorPosition',
        'type',
        'press',
        'keyDown',
        'keyUp',
        'getScreenSize',
        'getProcessStatus'
      ] as const;

      const spies: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const m of DESKTOP_METHODS) {
        spies[m] = vi.fn(async () => ({ method: m }));
      }
      (mockSandbox as any).desktop = spies;

      const { sandbox, ws } = await connectSandbox<{
        desktop: Record<string, (...args: any[]) => Promise<unknown>>;
      }>();
      try {
        const probes: Record<string, unknown[]> = {
          start: [{ resolution: [1024, 768] as [number, number] }],
          stop: [],
          status: [],
          screenshot: [{ format: 'base64' }],
          screenshotRegion: [{ x: 0, y: 0, width: 10, height: 10 }],
          click: [1, 2],
          doubleClick: [1, 2],
          tripleClick: [1, 2],
          rightClick: [1, 2],
          middleClick: [1, 2],
          mouseDown: [1, 2],
          mouseUp: [1, 2],
          moveMouse: [1, 2],
          drag: [0, 0, 5, 5],
          scroll: [1, 2, 'down'],
          getCursorPosition: [],
          type: ['hello'],
          press: ['Enter'],
          keyDown: ['Shift'],
          keyUp: ['Shift'],
          getScreenSize: [],
          getProcessStatus: ['xfwm4']
        };
        for (const m of DESKTOP_METHODS) {
          await sandbox.desktop[m](...probes[m]);
          expect(spies[m]).toHaveBeenCalledTimes(1);
          const actual = spies[m].mock.calls[0] as unknown[];
          expect(actual.slice(0, probes[m].length)).toEqual(probes[m]);
        }
      } finally {
        ws.close();
      }
    });
  });
});

describe('createBridgeApp() RPC route gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 for /v1/rpc when enableExperimentalRPC is unset', async () => {
    const { createBridgeApp } = await import('../src/bridge/routes');
    const app = createBridgeApp({
      sandboxBinding: 'Sandbox',
      warmPoolBinding: 'WarmPool',
      apiPrefix: '/v1',
      healthPath: '/health'
    });
    const res = await app.request(
      'http://localhost/v1/rpc',
      {
        method: 'GET',
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' }
      },
      createMockEnv()
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('not_found');
  });

  it('returns 101 for /v1/rpc when enableExperimentalRPC is true', async () => {
    const { createBridgeApp } = await import('../src/bridge/routes');
    const app = createBridgeApp({
      sandboxBinding: 'Sandbox',
      warmPoolBinding: 'WarmPool',
      apiPrefix: '/v1',
      healthPath: '/health',
      enableExperimentalRPC: true
    });
    const res = await app.request(
      'http://localhost/v1/rpc',
      {
        method: 'GET',
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' }
      },
      createMockEnv()
    );
    expect([101, 200]).toContain(res.status);
  });
});
