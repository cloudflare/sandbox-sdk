/**
 * TunnelService + TunnelManager unit tests.
 *
 * Mocks the `Bun.spawn` boundary (the cloudflared subprocess) so the real
 * TunnelManager + TunnelService code paths run end-to-end. We feed canned
 * cloudflared stderr through a streaming fake and stand up a minimal
 * `/ready` endpoint via `fetch` mock so the manager's readiness probe
 * sees what it expects.
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

function pushableStream() {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  return {
    stream: readable,
    write(chunk: string) {
      void writer.write(enc.encode(chunk));
    },
    close() {
      void writer.close();
    }
  };
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
  const exit = Promise.withResolvers<number>();
  let killFn: (signal: string) => void = () => {};
  const kill = mock((signal: string) => killFn(signal));
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
  // Auto-reap on SIGKILL so tests don't hang on TunnelManager.stop()'s
  // post-SIGKILL `await proc.exited`. SIGTERM is left to the test.
  killFn = (signal: string) => {
    if (signal === 'SIGKILL' && !proc.killed) {
      ctrl.resolveExit(137);
    }
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
    expect(argv).toContain('--no-autoupdate');
    expect(argv).toContain('--output');
    expect(argv).toContain('json');
    expect(argv).not.toContain('run');
  });

  it('returns a wire-shape record with the parsed URL', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-1', 8080)
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('quick-1');
    expect(result.data.name).toBeUndefined();
    expect(result.data.port).toBe(8080);
    expect(result.data.url).toBe('https://stub.trycloudflare.com');
    expect(result.data.hostname).toBe('stub.trycloudflare.com');
    expect(typeof result.data.createdAt).toBe('string');
    expect(() => new Date(result.data.createdAt as string)).not.toThrow();
  });

  it('parses the URL out of JSON-per-line stderr records', async () => {
    const service = new TunnelService(mockLogger);
    const jsonBanner = [
      JSON.stringify({
        level: 'info',
        message: 'Starting metrics server on 127.0.0.1:33333/metrics'
      }),
      JSON.stringify({
        level: 'info',
        message: '+--------------------------------------------------------+'
      }),
      JSON.stringify({
        level: 'info',
        message:
          '|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |'
      }),
      JSON.stringify({
        level: 'info',
        message: '|  https://random-words.trycloudflare.com                |'
      }),
      ''
    ].join('\n');

    const result = await withFakeCloudflared(jsonBanner, () =>
      service.runQuickTunnel('quick-json', 8080)
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.url).toBe('https://random-words.trycloudflare.com');
    expect(result.data.hostname).toBe('random-words.trycloudflare.com');
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

  it('returns TUNNEL_START_ERROR when readiness times out', async () => {
    const service = new TunnelService(mockLogger);

    const promise = service.runQuickTunnel('slow', 8080, {
      readyTimeoutMs: 50
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProcs).toHaveLength(1);
    // Never write a banner, never flip `/ready` — let it time out.

    const result = await promise;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('TUNNEL_START_ERROR');
    expect(result.error.message).toMatch(/Timed out/);
    expect(fakeProcs[0].kill).toHaveBeenCalled();
    expect(service.list()).toHaveLength(0);
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

  it('falls back to SIGKILL when SIGTERM does not exit the process', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('stubborn', 8080, { stopGraceMs: 20 })
    );

    const destroyPromise = service.destroyTunnel('stubborn');
    // Defer the exit until after the grace period; this should force the
    // SIGKILL fallback path.
    await new Promise((r) => setTimeout(r, 40));
    fakeProcs[0].resolveExit(137);
    const result = await destroyPromise;

    expect(result.success).toBe(true);
    expect(fakeProcs[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(fakeProcs[0].kill).toHaveBeenCalledWith('SIGKILL');
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
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('q2', 8081)
    );

    const all = service.list();
    expect(all.map((t) => t.id)).toEqual(['q1', 'q2']);
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

// ---------------------------------------------------------------------------
// Exit-callback wiring (container → DO via session remote main)
// ---------------------------------------------------------------------------

describe('TunnelService > exit callback', () => {
  it('invokes the callback when cloudflared exits naturally after start', async () => {
    const onTunnelExit = mock(async () => {});
    const service = new TunnelService(mockLogger, () => ({
      onTunnelExit
    }));
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-natural', 8080)
    );
    expect(service.list()).toHaveLength(1);

    // Simulate cloudflared crashing.
    fakeProcs[0].resolveExit(2);
    // Let the exit handler chain run.
    await new Promise((r) => setTimeout(r, 20));

    expect(onTunnelExit).toHaveBeenCalledTimes(1);
    expect(onTunnelExit).toHaveBeenCalledWith('quick-natural', 8080, 2);
    // Service registry is cleared so list() reflects truth.
    expect(service.list()).toHaveLength(0);
  });

  it('invokes the callback on the graceful stop path triggered by destroyTunnel', async () => {
    const onTunnelExit = mock(async () => {});
    const service = new TunnelService(mockLogger, () => ({
      onTunnelExit
    }));
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-graceful', 8080)
    );

    const destroyPromise = service.destroyTunnel('quick-graceful');
    await new Promise((r) => setTimeout(r, 5));
    fakeProcs[0].resolveExit(0);
    await destroyPromise;
    await new Promise((r) => setTimeout(r, 20));

    expect(onTunnelExit).toHaveBeenCalledTimes(1);
    expect(onTunnelExit).toHaveBeenCalledWith('quick-graceful', 8080, 0);
  });

  it('skips the callback when the accessor returns null (no session bound)', async () => {
    let nullCalls = 0;
    const service = new TunnelService(mockLogger, () => {
      nullCalls++;
      return null;
    });
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-nocb', 8080)
    );
    fakeProcs[0].resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
    // Accessor was at least consulted once on exit.
    expect(nullCalls).toBeGreaterThanOrEqual(1);
    // Service registry still cleared even with no DO to notify.
    expect(service.list()).toHaveLength(0);
  });

  it('swallows callback errors so a broken DO does not break the service', async () => {
    const onTunnelExit = mock(async () => {
      throw new Error('DO storage exploded');
    });
    const service = new TunnelService(mockLogger, () => ({
      onTunnelExit
    }));
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-bad-cb', 8080)
    );
    fakeProcs[0].resolveExit(0);
    // Should not throw, should not leave behind a registry entry.
    await new Promise((r) => setTimeout(r, 20));
    expect(onTunnelExit).toHaveBeenCalledTimes(1);
    expect(service.list()).toHaveLength(0);
  });

  it('omitting the accessor (legacy callers) is supported — no callback fired', async () => {
    // Backward-compat path: existing tests/code that don't pass a
    // callback accessor keep working.
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('quick-legacy', 8080)
    );
    fakeProcs[0].resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(service.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Named tunnels (`cloudflared tunnel run --token`)
// ---------------------------------------------------------------------------

/**
 * Canned stderr for a named-tunnel cloudflared. The metrics line still
 * appears (so the readiness probe can attach), but no `*.trycloudflare.com`
 * URL is emitted because there isn't one — the hostname is owned by the SDK.
 */
const NAMED_BANNER = [
  '2026-01-01T00:00:00Z INF Starting metrics server on 127.0.0.1:42425/metrics',
  '2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0',
  ''
].join('\n');

/**
 * Mirrors `withFakeCloudflared` but for the named flow: there's no URL
 * to wait for, so we just need the metrics server line on stderr and a
 * `/ready` flip.
 */
async function withFakeNamedCloudflared<T>(
  banner: string,
  fn: () => Promise<T>
): Promise<T> {
  const promise = fn();
  await new Promise((r) => setTimeout(r, 20));
  if (fakeProcs.length === 0) {
    throw new Error(
      'withFakeNamedCloudflared: TunnelService never spawned cloudflared'
    );
  }
  fakeProcs[fakeProcs.length - 1].stderr.write(banner);
  await new Promise((r) => setTimeout(r, 30));
  fetchHandler.ready = true;
  return await promise;
}

describe('TunnelService > runNamedTunnel', () => {
  it('spawns cloudflared with `tunnel run --token` argv', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeNamedCloudflared(NAMED_BANNER, () =>
      service.runNamedTunnel('named-1', 'OPAQUE_TOKEN', 8080)
    );

    expect(result.success).toBe(true);
    expect(fakeProcs).toHaveLength(1);
    const argv = fakeProcs[0].argv;
    expect(argv[0]).toBe('cloudflared');
    expect(argv).toContain('tunnel');
    expect(argv).toContain('run');
    expect(argv).toContain('--token');
    expect(argv).toContain('OPAQUE_TOKEN');
    expect(argv).toContain('--metrics');
    expect(argv).toContain('127.0.0.1:0');
    expect(argv).toContain('--no-autoupdate');
    // The local port is passed via `--url` so cloudflared knows where to
    // forward traffic (config_src=cloudflare populates ingress from the
    // edge, but `--url` overrides it locally for token-driven runs).
    expect(argv).toContain('--url');
    expect(argv).toContain('http://localhost:8080');
    // Quick-tunnel-only flags MUST NOT be present.
    expect(argv).not.toContain('--output');
  });

  it('returns a record without a public URL — the SDK fills hostname/url', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeNamedCloudflared(NAMED_BANNER, () =>
      service.runNamedTunnel('named-2', 'TOKEN_X', 9090)
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('named-2');
    expect(result.data.port).toBe(9090);
    // The container does not know the hostname for a token tunnel.
    expect(result.data.url).toBe('');
    expect(result.data.hostname).toBe('');
    expect(typeof result.data.createdAt).toBe('string');
  });

  it('never leaks the token in the returned record', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeNamedCloudflared(NAMED_BANNER, () =>
      service.runNamedTunnel('named-3', 'SECRET_TOKEN', 8080)
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(JSON.stringify(result.data)).not.toContain('SECRET_TOKEN');
  });

  it('refuses to start a named tunnel id that is already running', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeNamedCloudflared(NAMED_BANNER, () =>
      service.runNamedTunnel('dup-named', 'T', 8080)
    );

    const second = await service.runNamedTunnel('dup-named', 'T', 8081);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error.code).toBe('TUNNEL_ALREADY_RUNNING');
    expect(fakeProcs).toHaveLength(1);
  });

  it('shares the id-space with quick tunnels', async () => {
    // Mixing flavours under the same id should still collide — both go
    // through the same in-memory registry.
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.runQuickTunnel('shared-id', 8080)
    );
    const second = await service.runNamedTunnel('shared-id', 'T', 8081);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error.code).toBe('TUNNEL_ALREADY_RUNNING');
  });

  it('returns TUNNEL_START_ERROR when cloudflared exits before becoming ready', async () => {
    const service = new TunnelService(mockLogger);

    const promise = service.runNamedTunnel('named-fail', 'T', 8080);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProcs).toHaveLength(1);
    fakeProcs[0].resolveExit(1);

    const result = await promise;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('TUNNEL_START_ERROR');
    expect(service.list()).toHaveLength(0);
  });

  it('returns TUNNEL_START_ERROR when readiness times out', async () => {
    const service = new TunnelService(mockLogger);

    const promise = service.runNamedTunnel('named-slow', 'T', 8080, {
      readyTimeoutMs: 50
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProcs).toHaveLength(1);
    // Banner is never emitted -> metrics never resolved -> readiness times out.

    const result = await promise;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('TUNNEL_START_ERROR');
    expect(service.list()).toHaveLength(0);
  });

  it('destroyTunnel works against a named tunnel', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeNamedCloudflared(NAMED_BANNER, () =>
      service.runNamedTunnel('named-destroy', 'T', 8080)
    );

    const destroyPromise = service.destroyTunnel('named-destroy');
    await new Promise((r) => setTimeout(r, 5));
    fakeProcs[0].resolveExit(0);
    const result = await destroyPromise;

    expect(result.success).toBe(true);
    expect(fakeProcs[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(service.list()).toHaveLength(0);
  });

  it('fires the exit callback on natural exit of a named tunnel', async () => {
    const onTunnelExit = mock(async () => {});
    const service = new TunnelService(mockLogger, () => ({
      onTunnelExit
    }));
    await withFakeNamedCloudflared(NAMED_BANNER, () =>
      service.runNamedTunnel('named-exit', 'T', 8080)
    );
    fakeProcs[0].resolveExit(2);
    await new Promise((r) => setTimeout(r, 20));

    expect(onTunnelExit).toHaveBeenCalledTimes(1);
    expect(onTunnelExit).toHaveBeenCalledWith('named-exit', 8080, 2);
    expect(service.list()).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// Missing cloudflared binary
// ---------------------------------------------------------------------------

/**
 * Bun.spawn raises a synchronous Error when the executable can't be found
 * on $PATH. The wire shape matches what Bun actually emits:
 *   `{ code: 'ENOENT', path: 'cloudflared', errno: -2,
 *      message: 'Executable not found in $PATH: "cloudflared"' }`
 * The literal `$PATH` in the message used to leak into capnweb-serialized
 * error payloads and confused downstream tooling. TunnelService now
 * surfaces this as a dedicated `CLOUDFLARED_NOT_FOUND` error with a
 * human-readable message that the SDK / examples can detect.
 */
function makeEnoentError(): Error {
  const err = new Error(
    'Executable not found in $PATH: "cloudflared"'
  ) as Error & { code?: string; path?: string; errno?: number };
  err.code = 'ENOENT';
  err.path = 'cloudflared';
  err.errno = -2;
  return err;
}

describe('TunnelService > cloudflared binary missing', () => {
  it('runQuickTunnel returns CLOUDFLARED_NOT_FOUND when Bun.spawn throws ENOENT', async () => {
    spawnSpy?.mockImplementation((() => {
      throw makeEnoentError();
    }) as never);
    const service = new TunnelService(mockLogger);

    const result = await service.runQuickTunnel('q-enoent', 8080);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('CLOUDFLARED_NOT_FOUND');
    // Message must NOT contain the literal `$PATH` token — that string
    // poisons capnweb-serialized error payloads downstream.
    expect(result.error.message).not.toContain('$PATH');
    expect(result.error.message).toContain('cloudflared');
    expect(result.error.message).toMatch(/not found|missing|install/i);
  });

  it('runNamedTunnel returns CLOUDFLARED_NOT_FOUND when Bun.spawn throws ENOENT', async () => {
    spawnSpy?.mockImplementation((() => {
      throw makeEnoentError();
    }) as never);
    const service = new TunnelService(mockLogger);

    const result = await service.runNamedTunnel('n-enoent', 'TOK', 8080);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('CLOUDFLARED_NOT_FOUND');
    expect(result.error.message).not.toContain('$PATH');
    expect(result.error.message).toContain('cloudflared');
  });

  it('passes through other spawn errors as TUNNEL_START_ERROR', async () => {
    // Anything that isn't ENOENT keeps the generic error code so we
    // don't accidentally mask unrelated failures.
    spawnSpy?.mockImplementation((() => {
      throw new Error('EACCES: permission denied');
    }) as never);
    const service = new TunnelService(mockLogger);

    const result = await service.runQuickTunnel('q-eacces', 8080);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('TUNNEL_START_ERROR');
  });
});
