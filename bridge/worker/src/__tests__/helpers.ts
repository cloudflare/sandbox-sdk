import { vi } from 'vitest';

/**
 * Shape returned by `sandbox.exec()` / `session.exec()` after the unified
 * exec refactor (`docs/spikes/EXEC_UNIFICATION.md`). The bridge worker
 * consumes `stdout` / `stderr` byte streams and awaits `exitCode`, so the
 * helper below builds a minimal `SandboxProcess`-shaped object that
 * satisfies the bridge code while letting each test stage its own byte
 * sequences and exit code.
 */
export interface MockExecProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
  kill: (signal?: number | string) => void;
  output: (opts?: { encoding?: 'utf8' | 'buffer' }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
    duration: number;
    command: string;
    timestamp: string;
  }>;
}

/**
 * Bun.spawn-style thenable returned by `sandbox.exec()` after the unified
 * exec refactor: a `Promise<MockExecProcess>` plus `.output()` / `.text()`
 * / `.json()` / `.kill()` methods attached directly to the promise so
 * callers can write either `await sandbox.exec(cmd)` or
 * `await sandbox.exec(cmd).output()`.
 */
export type MockExecProcessPromise = Promise<MockExecProcess> & {
  output: MockExecProcess['output'];
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
  kill: (signal?: number | string) => Promise<void>;
};

/**
 * Wrap a `MockExecProcess` promise as a `MockExecProcessPromise`, matching
 * the production `createSandboxProcessPromise` shape so test code that
 * does `sandbox.exec(cmd).output()` works against the mock.
 */
export function asMockExecPromise(spawn: Promise<MockExecProcess>): MockExecProcessPromise {
  const promise = spawn as MockExecProcessPromise;
  promise.output = async (opts) => (await spawn).output(opts);
  promise.text = async () => (await promise.output()).stdout;
  promise.json = async <T>() => JSON.parse(await promise.text()) as T;
  promise.kill = async (signal) => {
    (await spawn).kill(signal);
  };
  return promise;
}

/**
 * Build a `MockExecProcess` whose `stdout` / `stderr` emit the given chunk
 * sequence (interleaved in declaration order) and whose `exitCode` resolves
 * to the given code after all chunks have been enqueued.
 *
 * Helpful for porting tests that previously used `onOutput` / `onComplete`
 * callbacks: each `{ stream, data }` entry maps 1:1 to an old
 * `onOutput(stream, data)` call.
 */
export function makeMockExecProcess(
  chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }> = [],
  options: { exitCode?: number; error?: Error; command?: string } = {}
): MockExecProcess {
  const encoder = new TextEncoder();
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  for (const c of chunks) {
    const bytes = encoder.encode(c.data);
    if (c.stream === 'stdout') stdoutChunks.push(bytes);
    else stderrChunks.push(bytes);
  }

  const makeStream = (payload: Uint8Array[]): ReadableStream<Uint8Array> | null =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of payload) controller.enqueue(c);
        controller.close();
      }
    });

  const exitCode = options.error ? Promise.reject(options.error) : Promise.resolve(options.exitCode ?? 0);
  // Mark observed so unhandled-rejection warnings don't flood tests that
  // never await `exitCode` directly.
  exitCode.catch(() => undefined);

  const command = options.command ?? '';

  return {
    stdout: makeStream(stdoutChunks),
    stderr: makeStream(stderrChunks),
    exitCode,
    kill: vi.fn(),
    output: async () => {
      const decoder = new TextDecoder();
      const code = await exitCode.catch(() => 1);
      return {
        stdout: stdoutChunks.map((c) => decoder.decode(c)).join(''),
        stderr: stderrChunks.map((c) => decoder.decode(c)).join(''),
        exitCode: code,
        success: code === 0,
        duration: 0,
        command,
        timestamp: new Date().toISOString()
      };
    }
  };
}

/**
 * Creates a mock session object matching the shape returned by sandbox.getSession().
 * Each method is a vi.fn() so tests can inspect calls and configure returns.
 *
 * The default `exec` returns a `MockExecProcessPromise` (thenable
 * `Promise<MockExecProcess>` with `.output()` / `.text()` / `.json()` /
 * `.kill()` attached). Override per-test via `vi.fn(() => asMockExecPromise(...))`.
 */
export function createMockSession(id = 'mock-session') {
  return {
    id,
    exec: vi.fn(() => asMockExecPromise(Promise.resolve(makeMockExecProcess()))),
    run: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      success: true,
      command: '',
      duration: 0,
      timestamp: new Date().toISOString()
    })),
    readFileStream: vi.fn(async () => new ReadableStream()),
    writeFile: vi.fn(async () => {})
  };
}

/**
 * Creates a mock sandbox object matching the shape returned by getSandbox().
 * Each method is a vi.fn() so tests can inspect calls and configure returns.
 *
 * The default `exec` returns a `MockExecProcessPromise` (thenable wrapping
 * a `MockExecProcess`). Override per-test via
 * `vi.fn(() => asMockExecPromise(...))` for streams/errors.
 */
export function createMockSandbox() {
  return {
    exec: vi.fn(() => asMockExecPromise(Promise.resolve(makeMockExecProcess()))),
    run: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      success: true,
      command: '',
      duration: 0,
      timestamp: new Date().toISOString()
    })),
    readFile: vi.fn(async () => ({ content: 'file content' })),
    readFileStream: vi.fn(async () => new ReadableStream()),
    writeFile: vi.fn(async () => {}),
    terminal: vi.fn((opts?: { id?: string }) => ({
      id: opts?.id ?? 'mock-terminal',
      // In real usage this returns a 101 WebSocket upgrade response, but Node
      // doesn't allow constructing Response with status 101, so we use 200.
      connect: vi.fn(async () => new Response(null, { status: 200 })),
      destroy: vi.fn(async () => {})
    })),
    getSession: vi.fn(async (sessionId: string) => createMockSession(sessionId)),
    createSession: vi.fn(async (opts?: { id?: string }) => ({
      id: opts?.id || 'auto-session-id'
    })),
    deleteSession: vi.fn(async (sessionId: string) => ({
      success: true,
      sessionId,
      timestamp: new Date().toISOString()
    })),
    mountBucket: vi.fn(async () => {}),
    unmountBucket: vi.fn(async () => {}),
    tunnels: {
      get: vi.fn(),
      destroy: vi.fn(async () => {})
    },
    destroy: vi.fn(async () => {})
  };
}

/** Base URL used for all test requests against the Hono app. */
export const BASE = 'http://localhost';

/** Convenience: build a full URL for a sandbox route. */
export function sandboxUrl(id: string, action: string, query?: string): string {
  const base = `${BASE}/v1/sandbox/${id}/${action}`;
  return query ? `${base}?${query}` : base;
}

/** Parse SSE events from raw text into an array of {event, data} objects. */
export function parseSSE(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  let currentEvent = '';
  let currentData = '';

  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      currentData += (currentData ? '\n' : '') + line.slice(6);
    } else if (line === '') {
      if (currentEvent) {
        events.push({ event: currentEvent, data: currentData });
        currentEvent = '';
        currentData = '';
      }
    }
  }
  return events;
}

/**
 * Creates a mock `Env` object with all required bindings for the Hono app.
 * The warm-pool middleware is satisfied by a stub that passes the sandbox ID
 * straight through as the container UUID — transparent to existing tests.
 */
export function createMockEnv(overrides?: Partial<{ SANDBOX_API_KEY: string }>) {
  const poolStub = {
    configure: vi.fn(async () => {}),
    getContainer: vi.fn(async (id: string) => id),
    lookupContainer: vi.fn(async (id: string) => id),
    getStats: vi.fn(async () => ({
      warm: 0,
      assigned: 0,
      total: 0,
      config: { warmTarget: 0, refreshInterval: 10000 },
      maxInstances: null
    })),
    shutdownPrewarmed: vi.fn(async () => {}),
    reportStopped: vi.fn(async () => {})
  };

  return {
    SANDBOX_API_KEY: overrides?.SANDBOX_API_KEY ?? '',
    Sandbox: {},
    WarmPool: {
      idFromName: vi.fn(() => ({ name: 'global-pool' })),
      get: vi.fn(() => poolStub)
    },
    WARM_POOL_TARGET: '0',
    WARM_POOL_REFRESH_INTERVAL: '10000',
    _poolStub: poolStub
  };
}

/**
 * Build an SSE-framed ReadableStream matching the format returned by
 * readFileStream(). Emits metadata, chunk, and complete events.
 */
export function createSSEFileStream(
  content: string,
  opts: { isBinary?: boolean; mimeType?: string } = {}
): ReadableStream<Uint8Array> {
  const isBinary = opts.isBinary ?? false;
  const mimeType = opts.mimeType ?? (isBinary ? 'application/octet-stream' : 'text/plain');
  const encoded = isBinary ? btoa(content) : content;
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      const metadata = JSON.stringify({
        type: 'metadata',
        mimeType,
        size: content.length,
        isBinary,
        encoding: isBinary ? 'base64' : 'utf-8'
      });
      controller.enqueue(encoder.encode(`data: ${metadata}\n\n`));

      const chunk = JSON.stringify({ type: 'chunk', data: encoded });
      controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));

      const complete = JSON.stringify({ type: 'complete' });
      controller.enqueue(encoder.encode(`data: ${complete}\n\n`));

      controller.close();
    }
  });
}
