/**
 * TunnelService + TunnelManager unit tests.
 *
 * Mocks the `Bun.spawn` boundary (the cloudflared subprocess) so the real
 * TunnelManager + TunnelService code paths run end-to-end. We feed
 * canned cloudflared stderr through a streaming fake and stand up a
 * minimal `/ready` endpoint via `fetch` mock so the manager's readiness
 * probe sees what it expects.
 *
 * What this catches:
 *   - Argv passed to cloudflared per mode (quick vs token).
 *   - Banner / structured-log parsing of the `*.trycloudflare.com` URL.
 *   - Readiness gating on `/ready` returning >=1 connection.
 *   - Wire shape returned from `runQuickTunnel` / `runTokenTunnel`
 *     (the regression we hit during the demo when capnweb couldn't
 *     deserialise the response).
 *   - Lifecycle: dedupe by id, rollback on early exit, destroy.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn
} from 'bun:test';
import type { Logger } from '@repo/shared';
import { TunnelService } from '@sandbox-container/services/tunnel-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pushableStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  const enc = new TextEncoder();
  return {
    stream,
    write(chunk: string) {
      controller!.enqueue(enc.encode(chunk));
    },
    close() {
      controller!.close();
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeProc {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: ReturnType<typeof mock>;
  killed: boolean;
}

interface FakeProcController {
  proc: FakeProc;
  stderr: ReturnType<typeof pushableStream>;
  resolveExit: (code: number) => void;
  kill: ReturnType<typeof mock>;
  argv: string[];
}

const fakeProcs: FakeProcController[] = [];
let originalFetch: typeof fetch;
const fetchHandler = { ready: false };

function makeFakeProc(argv: string[]): FakeProcController {
  const stderr = pushableStream();
  const stdoutEmpty = pushableStream();
  stdoutEmpty.close();
  const exit = deferred<number>();
  const kill = mock(() => {});
  const proc: FakeProc = {
    pid: 4242 + fakeProcs.length,
    stdout: stdoutEmpty.stream,
    stderr: stderr.stream,
    exited: exit.promise,
    kill,
    killed: false
  };
  const ctrl: FakeProcController = {
    proc,
    stderr,
    argv,
    resolveExit(code) {
      proc.killed = true;
      exit.resolve(code);
    },
    kill
  };
  fakeProcs.push(ctrl);
  return ctrl;
}

const mockLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  debug: mock(() => {}),
  child: mock(() => mockLogger)
} as unknown as Logger;

let spawnSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  fakeProcs.length = 0;
  fetchHandler.ready = false;

  // biome-ignore lint/suspicious/noExplicitAny: Bun's spawn types are tricky in tests
  spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => {
    return makeFakeProc(argv).proc as never;
  }) as never);

  originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.includes('/ready')) {
      return new Response('not found', { status: 404 });
    }
    return new Response(
      JSON.stringify({ readyConnections: fetchHandler.ready ? 1 : 0 }),
      { status: 200 }
    );
  }) as typeof fetch;
});

afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = null;
  global.fetch = originalFetch;
});

/**
 * Drives a TunnelService call to completion. Emits canned cloudflared
 * stderr after a short delay so the manager has a chance to subscribe to
 * the stream, then flips `/ready` so the readiness loop exits.
 */
async function withFakeCloudflared<T>(
  banner: string,
  fn: () => Promise<T>
): Promise<T> {
  const promise = fn();
  // Let the spawn happen and the stderr reader subscribe.
  await new Promise((r) => setTimeout(r, 20));
  if (fakeProcs.length === 0) {
    throw new Error(
      'withFakeCloudflared: TunnelService never spawned cloudflared'
    );
  }
  fakeProcs[fakeProcs.length - 1].stderr.write(banner);
  // Let scrapeStream pick up the metrics line + URL.
  await new Promise((r) => setTimeout(r, 30));
  fetchHandler.ready = true;
  return await promise;
}

const QUICK_BANNER = [
  '2026-01-01T00:00:00Z INF Starting metrics server on 127.0.0.1:42424/metrics',
  '2026-01-01T00:00:00Z INF Your quick tunnel: https://stub.trycloudflare.com',
  ''
].join('\n');

const TOKEN_BANNER = [
  '2026-01-01T00:00:00Z INF Starting metrics server on 127.0.0.1:42424/metrics',
  ''
].join('\n');

// ---------------------------------------------------------------------------

describe('TunnelService > runQuickTunnel', () => {
  it('spawns cloudflared with the expected argv', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-1', 8080)
    );

    expect(result.success).toBe(true);
    expect(fakeProcs).toHaveLength(1);
    const argv = fakeProcs[0].argv;
    expect(argv[0]).toBe('cloudflared');
    expect(argv).toContain('tunnel');
    expect(argv).toContain('--url');
    expect(argv).toContain('http://localhost:8080');
    expect(argv).toContain('--metrics');
    expect(argv).toContain('127.0.0.1:0');
    expect(argv).not.toContain('run');
  });

  it('returns a wire-shape record with mode "quick" and parsed URL', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-1', 8080)
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('quick-1');
    expect(result.data.mode).toBe('quick');
    expect(result.data.port).toBe(8080);
    expect(result.data.url).toBe('https://stub.trycloudflare.com');
    expect(result.data.hostname).toBe('stub.trycloudflare.com');
    expect(typeof result.data.createdAt).toBe('string');
    expect(() => new Date(result.data.createdAt as string)).not.toThrow();
  });

  it('refuses to start a tunnel id that is already running', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('dup', 8080)
    );

    const second = await service.runQuickTunnel('dup', 8081);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error.code).toBe('TUNNEL_ALREADY_RUNNING');
    // Only one cloudflared was spawned — the dup short-circuits before spawn.
    expect(fakeProcs).toHaveLength(1);
  });

  it('returns TUNNEL_START_ERROR when cloudflared exits before becoming ready', async () => {
    const service = new TunnelService(mockLogger);

    const promise = service.runQuickTunnel('fail', 8080);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProcs).toHaveLength(1);
    fakeProcs[0].resolveExit(1);

    const result = await promise;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('TUNNEL_START_ERROR');
    expect(result.error.message).toMatch(/exited before becoming ready/);
    expect(service.list()).toHaveLength(0);
  });
});

describe('TunnelService > runTokenTunnel', () => {
  it('passes --token and `run` subcommand to cloudflared', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeCloudflared(TOKEN_BANNER, () =>
      service.runTokenTunnel('tunnel-uuid-1', 'opaque-token', 8080)
    );

    expect(result.success).toBe(true);
    const argv = fakeProcs[0].argv;
    expect(argv).toContain('run');
    expect(argv).toContain('--token');
    expect(argv).toContain('opaque-token');
    expect(argv).toContain('--url');
    expect(argv).toContain('http://localhost:8080');
  });

  it('returns a record without url/hostname (the DO supplies them)', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeCloudflared(TOKEN_BANNER, () =>
      service.runTokenTunnel('tunnel-uuid-1', 'tok', 8080)
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('tunnel-uuid-1');
    expect(result.data.mode).toBe('token');
    expect(result.data.port).toBe(8080);
    expect(result.data.url).toBeUndefined();
    expect(result.data.hostname).toBeUndefined();
  });

  it('returns TUNNEL_ALREADY_RUNNING when the same id is replayed', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(TOKEN_BANNER, () =>
      service.runTokenTunnel('id', 'tok', 8080)
    );

    const second = await service.runTokenTunnel('id', 'tok', 8081);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error.code).toBe('TUNNEL_ALREADY_RUNNING');
  });
});

describe('TunnelService > destroyTunnel', () => {
  it('SIGTERMs cloudflared and removes the record', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('to-kill', 8080)
    );

    const destroyPromise = service.destroyTunnel('to-kill');
    // Cooperate so we don't race the SIGKILL fallback inside TunnelManager.stop().
    await new Promise((r) => setTimeout(r, 5));
    fakeProcs[0].resolveExit(0);
    const result = await destroyPromise;

    expect(result.success).toBe(true);
    expect(fakeProcs[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(fakeProcs[0].kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(service.list()).toHaveLength(0);
  });

  it('returns TUNNEL_NOT_FOUND for unknown ids', async () => {
    const service = new TunnelService(mockLogger);
    const result = await service.destroyTunnel('ghost');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('TUNNEL_NOT_FOUND');
  });
});

describe('TunnelService > list & destroyAll', () => {
  it('returns all running tunnels in insertion order', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('q1', 8080)
    );
    await withFakeCloudflared(TOKEN_BANNER, () =>
      service.runTokenTunnel('t1', 'tok', 8081)
    );

    const all = service.list();
    expect(all.map((t) => t.id)).toEqual(['q1', 't1']);
  });

  it('destroyAll stops every running tunnel', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('a', 8080)
    );
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('b', 8081)
    );

    const destroyAll = service.destroyAll();
    await new Promise((r) => setTimeout(r, 5));
    for (const p of fakeProcs) p.resolveExit(0);
    await destroyAll;

    expect(service.list()).toHaveLength(0);
    for (const p of fakeProcs) {
      expect(p.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });
});
