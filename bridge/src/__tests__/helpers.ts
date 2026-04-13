import { vi } from 'vitest';

/**
 * Creates a mock session object matching the shape returned by sandbox.getSession().
 * Each method is a vi.fn() so tests can inspect calls and configure returns.
 *
 * The `exec` mock supports streaming: when called with `stream: true`, it
 * invokes `onOutput` / `onComplete` / `onError` callbacks.
 */
export function createMockSession(id = 'mock-session') {
  return {
    id,
    exec: vi.fn(async (_cmd: string, opts?: Record<string, unknown>) => {
      const result = { stdout: '', stderr: '', exitCode: 0 };
      if (opts?.stream) {
        if (opts.onOutput && typeof opts.onOutput === 'function') {
          if (result.stdout) (opts.onOutput as (s: string, d: string) => void)('stdout', result.stdout);
          if (result.stderr) (opts.onOutput as (s: string, d: string) => void)('stderr', result.stderr);
        }
        if (opts.onComplete && typeof opts.onComplete === 'function') {
          (opts.onComplete as (r: { exitCode: number }) => void)(result);
        }
      }
      return result;
    }),
    readFileStream: vi.fn(async () => new ReadableStream()),
    writeFile: vi.fn(async () => {}),
    terminal: vi.fn(async () => new Response(null, { status: 200 }))
  };
}

/**
 * Creates a mock sandbox object matching the shape returned by getSandbox().
 * Each method is a vi.fn() so tests can inspect calls and configure returns.
 *
 * The `exec` mock supports streaming: when called with `stream: true`, it
 * invokes `onOutput` / `onComplete` / `onError` callbacks instead of just
 * returning a result.
 */
export function createMockSandbox() {
  return {
    exec: vi.fn(async (_cmd: string, opts?: Record<string, unknown>) => {
      const result = { stdout: '', stderr: '', exitCode: 0 };
      if (opts?.stream) {
        // Streaming mode — fire callbacks if provided
        if (opts.onOutput && typeof opts.onOutput === 'function') {
          if (result.stdout) (opts.onOutput as (s: string, d: string) => void)('stdout', result.stdout);
          if (result.stderr) (opts.onOutput as (s: string, d: string) => void)('stderr', result.stderr);
        }
        if (opts.onComplete && typeof opts.onComplete === 'function') {
          (opts.onComplete as (r: { exitCode: number }) => void)(result);
        }
      }
      return result;
    }),
    readFile: vi.fn(async () => ({ content: 'file content' })),
    readFileStream: vi.fn(async () => new ReadableStream()),
    writeFile: vi.fn(async () => {}),
    terminal: vi.fn(async (_request: Request, _opts?: Record<string, unknown>) => {
      // In real usage this returns a 101 WebSocket upgrade response, but Node
      // doesn't allow constructing Response with status 101, so we use 200.
      return new Response(null, { status: 200 });
    }),
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
    WARM_POOL: {
      idFromName: vi.fn(() => ({ name: 'global-pool' })),
      get: vi.fn(() => poolStub)
    },
    WARM_POOL_TARGET: '0',
    WARM_POOL_REFRESH_INTERVAL: '10000',
    _poolStub: poolStub
  };
}
