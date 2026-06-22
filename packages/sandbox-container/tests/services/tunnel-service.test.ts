/**
 * TunnelService runtime-run unit tests.
 *
 * Mocks the `Bun.spawn` boundary so the real TunnelManager path runs
 * end-to-end while tests drive cloudflared stderr and readiness responses.
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
import type { Logger, TunnelRunExitEvent } from '@repo/shared';
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

async function withFakeCloudflared<T>(
  banner: string,
  fn: () => Promise<T>
): Promise<T> {
  const promise = fn();
  await new Promise((r) => setTimeout(r, 20));
  if (fakeProcs.length === 0) {
    throw new Error(
      'withFakeCloudflared: TunnelService never spawned cloudflared'
    );
  }
  fakeProcs[fakeProcs.length - 1].stderr.write(banner);
  await new Promise((r) => setTimeout(r, 30));
  fetchHandler.ready = true;
  return await promise;
}

const QUICK_BANNER = [
  '2026-01-01T00:00:00Z INF Starting metrics server on 127.0.0.1:42424/metrics',
  '2026-01-01T00:00:00Z INF Your quick tunnel: https://stub.trycloudflare.com',
  ''
].join('\n');

const NAMED_BANNER = [
  '2026-01-01T00:00:00Z INF Starting metrics server on 127.0.0.1:42424/metrics',
  ''
].join('\n');

function quickRequest(overrides = {}) {
  return {
    mode: 'quick' as const,
    tunnelId: 'quick-1',
    runId: 'run-1',
    port: 8080,
    ...overrides
  };
}

function namedRequest(overrides = {}) {
  return {
    mode: 'named' as const,
    tunnelId: 'named-1',
    runId: 'run-1',
    port: 8080,
    cloudflaredToken: 'OPAQUE_TOKEN',
    ...overrides
  };
}

describe('TunnelService > ensureTunnelRun', () => {
  it('starts a quick runtime run and returns a quick snapshot', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.started).toBe(true);
    expect(result.data.run).toMatchObject({
      mode: 'quick',
      tunnelId: 'quick-1',
      runId: 'run-1',
      port: 8080,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com'
    });
    expect(fakeProcs[0].argv).toEqual([
      'cloudflared',
      'tunnel',
      '--metrics',
      expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      '--no-autoupdate',
      '--output',
      'json',
      '--url',
      'http://localhost:8080'
    ]);
  });

  it('starts a named runtime run without returning public hostname state', async () => {
    const service = new TunnelService(mockLogger);

    const result = await withFakeCloudflared(NAMED_BANNER, () =>
      service.ensureTunnelRun(namedRequest())
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.run).toMatchObject({
      mode: 'named',
      tunnelId: 'named-1',
      runId: 'run-1',
      port: 8080
    });
    expect(JSON.stringify(result.data.run)).not.toContain('OPAQUE_TOKEN');
    expect(fakeProcs[0].argv).toEqual([
      'cloudflared',
      'tunnel',
      '--metrics',
      expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      '--no-autoupdate',
      'run',
      '--token',
      'OPAQUE_TOKEN',
      '--url',
      'http://localhost:8080'
    ]);
  });

  it('returns the existing run when the same run id is replayed', async () => {
    const service = new TunnelService(mockLogger);
    const request = quickRequest();

    const first = await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(request)
    );
    const second = await service.ensureTunnelRun(request);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.data.started).toBe(true);
    expect(second.data.started).toBe(false);
    expect(second.data.run).toEqual(first.data.run);
    expect(fakeProcs).toHaveLength(1);
  });

  it('rejects a same-run replay with different parameters', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    const second = await service.ensureTunnelRun(quickRequest({ port: 8081 }));

    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error.code).toBe('TUNNEL_RUN_CONFLICT');
    expect(fakeProcs).toHaveLength(1);
  });

  it('rejects a different run on the same port', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    const second = await service.ensureTunnelRun(
      quickRequest({ tunnelId: 'quick-2', runId: 'run-2' })
    );

    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error.code).toBe('TUNNEL_RUN_CONFLICT');
    expect(fakeProcs).toHaveLength(1);
  });

  it('rejects a different run for the same tunnel id', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    const second = await service.ensureTunnelRun(
      quickRequest({ runId: 'run-2', port: 8081 })
    );

    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error.code).toBe('TUNNEL_RUN_CONFLICT');
    expect(fakeProcs).toHaveLength(1);
  });

  it('returns CLOUDFLARED_NOT_FOUND when Bun.spawn throws ENOENT', async () => {
    spawnSpy?.mockRestore();
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
      const err = new Error(
        'ENOENT: no such file or directory, spawn cloudflared'
      ) as Error & { code: string; path: string };
      err.code = 'ENOENT';
      err.path = 'cloudflared';
      throw err;
    });
    const service = new TunnelService(mockLogger);

    const result = await service.ensureTunnelRun(quickRequest());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('CLOUDFLARED_NOT_FOUND');
  });
});

describe('TunnelService > runtime run registry', () => {
  it('returns active run snapshots by run id and list order', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(
        quickRequest({ tunnelId: 'quick-2', runId: 'run-2', port: 8081 })
      )
    );

    expect(service.getTunnelRun('run-1')?.tunnelId).toBe('quick-1');
    expect(service.listTunnelRuns().map((run) => run.runId)).toEqual([
      'run-1',
      'run-2'
    ]);
  });

  it('stops the exact active run by run id', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    const stop = service.stopTunnelRun({ runId: 'run-1' });
    await new Promise((r) => setTimeout(r, 5));
    fakeProcs[0].resolveExit(0);
    const result = await stop;

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ matched: true, stopped: true });
    expect(fakeProcs[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(service.getTunnelRun('run-1')).toBeNull();
  });

  it('does not stop a run when the tunnel id does not match', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    const result = await service.stopTunnelRun({
      tunnelId: 'quick-other',
      runId: 'run-1'
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ matched: false, stopped: false });
    expect(fakeProcs[0].kill).not.toHaveBeenCalled();
    expect(service.getTunnelRun('run-1')).not.toBeNull();
  });

  it('destroyAll stops every runtime run', async () => {
    const service = new TunnelService(mockLogger);
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(
        quickRequest({ tunnelId: 'quick-2', runId: 'run-2', port: 8081 })
      )
    );

    const destroyAll = service.destroyAll();
    await new Promise((r) => setTimeout(r, 5));
    for (const proc of fakeProcs) proc.resolveExit(0);
    await destroyAll;

    expect(service.listTunnelRuns()).toEqual([]);
    for (const proc of fakeProcs) {
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });
});

describe('TunnelService > exit callback', () => {
  it('emits an object-shaped run exit event and clears the registry', async () => {
    const onTunnelRunExit = mock(async (_event: TunnelRunExitEvent) => {});
    const service = new TunnelService(mockLogger, () => ({
      onTunnelRunExit
    }));
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    fakeProcs[0].resolveExit(2);
    await new Promise((r) => setTimeout(r, 20));

    expect(onTunnelRunExit).toHaveBeenCalledTimes(1);
    expect(onTunnelRunExit).toHaveBeenCalledWith({
      tunnelId: 'quick-1',
      runId: 'run-1',
      mode: 'quick',
      port: 8080,
      exitCode: 2
    });
    expect(service.getTunnelRun('run-1')).toBeNull();
  });

  it('skips the callback when the accessor returns null', async () => {
    let nullCalls = 0;
    const service = new TunnelService(mockLogger, () => {
      nullCalls += 1;
      return null;
    });
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    fakeProcs[0].resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));

    expect(nullCalls).toBeGreaterThanOrEqual(1);
    expect(service.getTunnelRun('run-1')).toBeNull();
  });

  it('logs callback errors without retaining the exited run', async () => {
    const onTunnelRunExit = mock(async () => {
      throw new Error('DO storage exploded');
    });
    const service = new TunnelService(mockLogger, () => ({
      onTunnelRunExit
    }));
    await withFakeCloudflared(QUICK_BANNER, () =>
      service.ensureTunnelRun(quickRequest())
    );

    fakeProcs[0].resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));

    expect(onTunnelRunExit).toHaveBeenCalledTimes(1);
    expect(service.getTunnelRun('run-1')).toBeNull();
  });
});
