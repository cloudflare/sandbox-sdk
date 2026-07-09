import type { ProcessLogEvent, ProcessStatus, SandboxCommand, TerminalSnapshot } from '@repo/shared';
import { vi } from 'vitest';

type MockProcess = ReturnType<typeof createMockProcess>;
type MockTerminal = ReturnType<typeof createMockTerminal>;

export function createMockProcess(overrides: Partial<ProcessStatus> & { logs?: ProcessLogEvent[] } = {}) {
  const base = {
    id: overrides.id ?? 'mock-process',
    command: overrides.command ?? ['echo', 'ok'],
    cwd: overrides.cwd,
    startedAt: overrides.startedAt ?? '2026-07-08T00:00:00.000Z',
    pid: overrides.pid ?? 123
  };
  const status: ProcessStatus =
    overrides.state === 'exited'
      ? {
          ...base,
          state: 'exited',
          exit: overrides.exit,
          endedAt: overrides.endedAt
        }
      : overrides.state === 'error'
        ? {
            ...base,
            state: 'error',
            error: overrides.error,
            endedAt: overrides.endedAt
          }
        : { ...base, state: 'running' };
  const logEvents = overrides.logs ?? [];

  return {
    id: status.id,
    pid: status.pid,
    status: vi.fn(async () => status),
    logs: vi.fn(
      async () =>
        new ReadableStream<ProcessLogEvent>({
          start(controller) {
            for (const event of logEvents) controller.enqueue(event);
            controller.close();
          }
        })
    ),
    waitForExit: vi.fn(async () => (status.state === 'exited' ? status.exit : { code: 0, timedOut: false })),
    waitForLog: vi.fn(),
    waitForPort: vi.fn(),
    kill: vi.fn(async () => {})
  };
}

export function createMockTerminal(overrides: Partial<TerminalSnapshot> = {}) {
  const snapshot: TerminalSnapshot = {
    id: overrides.id ?? 'mock-terminal',
    command: overrides.command ?? ['bash'],
    cwd: overrides.cwd,
    status: overrides.status ?? 'running',
    pid: overrides.pid,
    exit: overrides.exit
  };
  return {
    id: snapshot.id,
    getSnapshot: vi.fn(async () => snapshot),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    output: vi.fn(async () => new ReadableStream()),
    waitForExit: vi.fn(async () => snapshot.exit ?? { code: 0, timedOut: false }),
    interrupt: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    connect: vi.fn(async () => new Response(null, { status: 200 }))
  };
}

/**
 * Creates a mock sandbox object matching the shape returned by getSandbox().
 * Each method is a vi.fn() so tests can inspect calls and configure returns.
 */
export function createMockSandbox() {
  const sandbox = {
    exec: vi.fn(async (argv: SandboxCommand) => createMockProcess({ command: argv })),
    getProcess: vi.fn(async (id: string): Promise<MockProcess | null> => createMockProcess({ id })),
    listProcesses: vi.fn(async (): Promise<ProcessStatus[]> => []),
    isRuntimeActive: vi.fn(async () => true),
    readFile: vi.fn(async () => ({ content: 'file content' })),
    readFileStream: vi.fn(async () => new ReadableStream()),
    writeFile: vi.fn(async () => {}),
    createWorkspaceArchive: vi.fn(async () => '/tmp/sandbox-workspace-test.tar'),
    extractWorkspaceArchive: vi.fn(async () => {}),
    cleanupWorkspaceArchive: vi.fn(async () => {}),
    cleanupMountDirectory: vi.fn(async () => {}),
    createTerminal: vi.fn(async (): Promise<MockTerminal> => createMockTerminal()),
    getTerminal: vi.fn(async (id: string): Promise<MockTerminal | null> => createMockTerminal({ id })),
    listTerminals: vi.fn(async (): Promise<MockTerminal[]> => []),
    mountBucket: vi.fn(async () => {}),
    unmountBucket: vi.fn(async () => {}),
    tunnels: {
      get: vi.fn(),
      destroy: vi.fn(async () => {})
    },
    destroy: vi.fn(async () => {})
  };
  return sandbox;
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
      if (currentEvent || currentData) {
        events.push({ event: currentEvent, data: currentData });
      }
      currentEvent = '';
      currentData = '';
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
