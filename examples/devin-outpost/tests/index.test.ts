import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import worker, { CheckpointProxy, DevinWorker } from '../src/index';
import {
  acceptorId,
  type DevinSessionSummary,
  sessionCommand
} from '../src/lifecycle';
import { fetchSessions, reconcile } from '../src/reconcile';

function item(
  sessionId: string,
  sessionStatus: string | null,
  phase = 'claimed'
): DevinSessionSummary {
  return {
    metadata: { session_id: sessionId, pool_id: 'pool-1' },
    status: { phase, session_status: sessionStatus }
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

type WorkerStub = {
  ensureRunning: Mock;
  stop: Mock;
};

type TestNamespace = Env['DevinWorker'] & {
  stubs: Map<string, WorkerStub>;
};

function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DEVIN_POOL_ID: 'pool-1',
    DEVIN_API_URL: 'https://api.example.test',
    DEVIN_CHECKPOINTS: {
      head: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    },
    WORKER_ID_PREFIX: 'cf-outpost',
    DEVIN_API_TOKEN: 'secret-token',
    DevinWorker: makeNamespace(),
    ...overrides
  } as unknown as Env;
}

function stubFor(stubs: Map<string, WorkerStub>, id: string): WorkerStub {
  const stub = stubs.get(id);
  if (!stub) throw new Error(`missing stub for ${id}`);
  return stub;
}

function makeNamespace(stubs = new Map<string, WorkerStub>()): TestNamespace {
  return {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn((id: string) => {
      if (!stubs.has(id)) {
        stubs.set(id, {
          ensureRunning: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined)
        });
      }
      return stubFor(stubs, id);
    }),
    stubs
  } as unknown as TestNamespace;
}

type ContainerStartOptions = {
  enableInternet: boolean;
  env: Record<string, string>;
};

function fakeContainer(running = false, destroyError?: Error) {
  return {
    running,
    starts: [] as ContainerStartOptions[],
    destroyed: 0,
    monitors: 0,
    events: [] as string[],
    interceptions: [] as Array<{ host: string; binding: unknown }>,
    async interceptOutboundHttp(host: string, binding: unknown) {
      this.interceptions.push({ host, binding });
    },
    start(options: ContainerStartOptions) {
      this.running = true;
      this.starts.push(options);
    },
    async destroy() {
      this.events.push('destroy');
      if (destroyError) throw destroyError;
      this.running = false;
      this.destroyed++;
    },
    monitor() {
      this.monitors++;
      return new Promise<void>(() => undefined);
    }
  };
}

function makeCtx(container = fakeContainer()) {
  const checkpointBinding = { fetch: vi.fn() };
  return {
    container,
    exports: {
      CheckpointProxy: vi.fn(() => checkpointBinding)
    },
    checkpointBinding,
    waitUntil: vi.fn()
  };
}

const TestDevinWorker = DevinWorker as unknown as new (
  ctx: ReturnType<typeof makeCtx>,
  env: Env
) => DevinWorker;

function newTestDevinWorker(
  ctx: ReturnType<typeof makeCtx>,
  env: Env
): DevinWorker {
  return new TestDevinWorker(ctx, env);
}

const TestCheckpointProxy = CheckpointProxy as unknown as new (
  ctx: { props: { sessionId: string } },
  env: Env
) => CheckpointProxy;

describe('checkpoint proxy', () => {
  it('streams one trusted session key to and from R2', async () => {
    let fixedLength = 0;
    vi.stubGlobal(
      'FixedLengthStream',
      class {
        readonly readable: ReadableStream;
        readonly writable: WritableStream;
        constructor(length: number) {
          fixedLength = length;
          const stream = new TransformStream();
          this.readable = stream.readable;
          this.writable = stream.writable;
        }
      }
    );
    const stored = new Response('saved archive');
    let uploaded = '';
    const bucket = {
      head: vi.fn().mockResolvedValue({ size: 13 }),
      get: vi.fn().mockResolvedValue({ body: stored.body, size: 13 }),
      put: vi.fn(async (_key: string, body: ReadableStream) => {
        uploaded = await new Response(body).text();
      }),
      delete: vi.fn()
    };
    const proxy = new TestCheckpointProxy(
      { props: { sessionId: 'devin-1' } },
      baseEnv({ DEVIN_CHECKPOINTS: bucket })
    );
    const upload = new Request(
      'http://checkpoint.internal/checkpoint?key=sessions/devin-2.tar.zst',
      {
        method: 'PUT',
        headers: { 'content-length': '11' },
        body: 'new archive'
      }
    );

    await expect(proxy.fetch(upload)).resolves.toMatchObject({ status: 204 });
    expect(bucket.put).toHaveBeenCalledWith(
      'sessions/devin-1.tar.zst',
      expect.any(ReadableStream)
    );
    expect(uploaded).toBe('new archive');
    expect(fixedLength).toBe(11);

    const head = await proxy.fetch(
      new Request('http://checkpoint.internal/checkpoint', { method: 'HEAD' })
    );
    expect(head.status).toBe(200);
    expect(bucket.head).toHaveBeenCalledWith('sessions/devin-1.tar.zst');

    const download = await proxy.fetch(
      new Request('http://checkpoint.internal/checkpoint')
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-length')).toBe('13');
    await expect(download.text()).resolves.toBe('saved archive');
  });

  it('is not routed through the public Worker endpoint', async () => {
    await expect(
      worker.fetch(new Request('https://outpost.example/checkpoint'))
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      worker.fetch(new Request('https://outpost.example/'))
    ).resolves.toMatchObject({ status: 200 });
  });

  it('exposes only the checkpoint path and supported methods', async () => {
    const env = baseEnv();
    const proxy = new TestCheckpointProxy(
      { props: { sessionId: 'devin-1' } },
      env
    );

    await expect(
      proxy.fetch(new Request('http://checkpoint.internal/other'))
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      proxy.fetch(
        new Request('http://checkpoint.internal/checkpoint', {
          method: 'PUT',
          body: 'unknown length'
        })
      )
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      proxy.fetch(
        new Request('http://checkpoint.internal/checkpoint', {
          method: 'PUT',
          headers: { 'content-length': String(5 * 1024 ** 3 + 1) },
          body: 'too large'
        })
      )
    ).resolves.toMatchObject({ status: 413 });
    expect(env.DEVIN_CHECKPOINTS.put).not.toHaveBeenCalled();
    await expect(
      proxy.fetch(
        new Request('http://checkpoint.internal/checkpoint', {
          method: 'DELETE'
        })
      )
    ).resolves.toMatchObject({ status: 405 });
  });
});

describe('documented Devin session status mapping', () => {
  it.each([
    ['pending', 'ensureRunning'],
    ['running', 'ensureRunning'],
    ['suspended', 'stop'],
    ['terminated', 'stop'],
    ['completed', 'ignore'],
    ['failed', 'ignore'],
    ['', 'ignore'],
    [null, 'ignore'],
    [undefined, 'ignore']
  ] as const)('maps %s to %s', (status, command) => {
    expect(sessionCommand(status)).toBe(command);
  });

  it('uses a deterministic per-session acceptor id', () => {
    expect(acceptorId('cf-outpost', 'devin-123')).toBe('cf-outpost-devin-123');
    expect(acceptorId('outpost-a', 'devin-123')).toBe('outpost-a-devin-123');
  });
});

describe('Devin API fetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches the full pool with one documented pool query', async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await expect(fetchSessions(baseEnv())).resolves.toEqual({ items: [] });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/opbeta/outposts/devins?pool=pool-1',
      {
        headers: { Authorization: 'Bearer secret-token' },
        signal: expect.any(AbortSignal)
      }
    );
  });

  it('url-encodes pool ids', async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await fetchSessions(baseEnv({ DEVIN_POOL_ID: 'pool with spaces' }));

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/opbeta/outposts/devins?pool=pool%20with%20spaces',
      expect.anything()
    );
  });

  it('follows has_next_page instead of the terminal cursor', async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch
      .mockResolvedValueOnce(
        jsonResponse({
          items: [item('devin-1', 'running')],
          cursor: 'page-2',
          has_next_page: true
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [item('devin-2', 'pending')],
          cursor: 'terminal-cursor-is-still-present',
          has_next_page: false
        })
      );

    await expect(fetchSessions(baseEnv())).resolves.toEqual({
      items: [item('devin-1', 'running'), item('devin-2', 'pending')]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      'https://api.example.test/opbeta/outposts/devins?pool=pool-1&cursor=page-2',
      expect.anything()
    );
  });
});

describe('Worker reconciliation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('sends explicit DO commands for every documented lifecycle state', async () => {
    const stubs = new Map<string, WorkerStub>();
    const env = baseEnv({ DevinWorker: makeNamespace(stubs) });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        items: [
          item('devin-pending', 'pending', 'pending'),
          item('devin-running', 'running'),
          item('devin-suspended', 'suspended'),
          item('devin-terminated', 'terminated')
        ]
      })
    );

    await expect(reconcile(env)).resolves.toMatchObject({
      scanned: 4,
      ensured: 2,
      stopped: 2,
      ignored: 0,
      errors: []
    });

    expect(
      stubFor(stubs, 'id:devin-pending').ensureRunning
    ).toHaveBeenCalledWith(
      'devin-pending',
      'pool-1',
      'cf-outpost-devin-pending'
    );
    expect(
      stubFor(stubs, 'id:devin-running').ensureRunning
    ).toHaveBeenCalledWith(
      'devin-running',
      'pool-1',
      'cf-outpost-devin-running'
    );
    expect(stubFor(stubs, 'id:devin-suspended').stop).toHaveBeenCalledWith(
      'devin-suspended',
      'suspended'
    );
    expect(stubFor(stubs, 'id:devin-terminated').stop).toHaveBeenCalledWith(
      'devin-terminated',
      'terminated'
    );
  });

  it('logs and ignores unknown statuses instead of touching a DO', async () => {
    const namespace = makeNamespace();
    const env = baseEnv({ DevinWorker: namespace });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ items: [item('devin-weird', 'completed')] })
    );

    await expect(reconcile(env)).resolves.toMatchObject({
      scanned: 1,
      ensured: 0,
      stopped: 0,
      ignored: 1,
      errors: []
    });

    expect(namespace.get).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[devin-weird] unhandled session_status="completed" phase="claimed"'
    );
  });

  it('does not touch containers when the Devin API request fails', async () => {
    const namespace = makeNamespace();
    const env = baseEnv({ DevinWorker: namespace });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('nope', { status: 500 })
    );

    await expect(reconcile(env)).rejects.toThrow('Devin API 500: nope');
    expect(namespace.get).not.toHaveBeenCalled();
  });

  it('does not call Devin without required config', async () => {
    const fetch = vi.mocked(globalThis.fetch);

    await expect(
      reconcile(baseEnv({ DEVIN_POOL_ID: '' }))
    ).resolves.toMatchObject({
      errors: ['DEVIN_POOL_ID is not set']
    });
    await expect(
      reconcile(baseEnv({ DEVIN_API_TOKEN: '' }))
    ).resolves.toMatchObject({
      errors: ['DEVIN_API_TOKEN is not set']
    });
    await expect(
      reconcile(baseEnv({ DEVIN_API_URL: '' }))
    ).resolves.toMatchObject({
      errors: ['DEVIN_API_URL is not set']
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('scheduled events run the same reconcile loop', async () => {
    const env = baseEnv();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ items: [item('devin-running', 'running')] })
    );

    await worker.scheduled({} as ScheduledEvent, env);

    const stub = stubFor(
      (env.DevinWorker as unknown as TestNamespace).stubs,
      'id:devin-running'
    );
    expect(stub.ensureRunning).toHaveBeenCalledOnce();
  });
});

describe('Durable Object container actuator', () => {
  it('starts a stopped container with the expected Devin worker env', async () => {
    const container = fakeContainer(false);
    const ctx = makeCtx(container);
    const durableObject = newTestDevinWorker(ctx, baseEnv());

    await durableObject.ensureRunning('devin-1', 'pool-1', 'acceptor-1');

    expect(container.running).toBe(true);
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0]).toEqual({
      enableInternet: true,
      env: {
        DEVIN_OUTPOST_SESSION_ID: 'devin-1',
        DEVIN_POOL_ID: 'pool-1',
        DEVIN_WORKER_ACCEPTOR_ID: 'acceptor-1',
        DEVIN_API_TOKEN: 'secret-token',
        DEVIN_API_URL: 'https://api.example.test',
        DEVIN_OUTPOST_DESKTOP: 'true',
        DEVIN_CHROME_PATH: '/usr/bin/chromium',
        HOME: '/root',
        USER: 'root',
        LOGNAME: 'root',
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8'
      }
    });
    expect(ctx.exports.CheckpointProxy).toHaveBeenCalledWith({
      props: { sessionId: 'devin-1' }
    });
    expect(container.interceptions).toEqual([
      { host: 'checkpoint.internal', binding: ctx.checkpointBinding }
    ]);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent starts while interception is being installed', async () => {
    const container = fakeContainer(false);
    let release!: () => void;
    container.interceptOutboundHttp = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const durableObject = newTestDevinWorker(makeCtx(container), baseEnv());

    const first = durableObject.ensureRunning(
      'devin-1',
      'pool-1',
      'acceptor-1'
    );
    const second = durableObject.ensureRunning(
      'devin-1',
      'pool-1',
      'acceptor-1'
    );
    release();
    await Promise.all([first, second]);

    expect(container.interceptOutboundHttp).toHaveBeenCalledOnce();
    expect(container.starts).toHaveLength(1);
  });

  it('waits for an in-flight start before terminating', async () => {
    const container = fakeContainer(false);
    let release!: () => void;
    container.interceptOutboundHttp = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const env = baseEnv();
    const durableObject = newTestDevinWorker(makeCtx(container), env);

    const start = durableObject.ensureRunning(
      'devin-1',
      'pool-1',
      'acceptor-1'
    );
    const stop = durableObject.stop('devin-1', 'terminated');
    release();
    await Promise.all([start, stop]);

    expect(container.starts).toHaveLength(1);
    expect(container.destroyed).toBe(1);
    expect(env.DEVIN_CHECKPOINTS.delete).toHaveBeenCalledWith(
      'sessions/devin-1.tar.zst'
    );
  });

  it('is idempotent when ensureRunning is called for an already-running container', async () => {
    const container = fakeContainer(true);
    const durableObject = newTestDevinWorker(makeCtx(container), baseEnv());

    await durableObject.ensureRunning('devin-1', 'pool-1', 'acceptor-1');

    expect(container.starts).toHaveLength(0);
    expect(container.running).toBe(true);
  });

  it('lets the entrypoint finish its checkpoint when a session suspends', async () => {
    const container = fakeContainer(true);
    const durableObject = newTestDevinWorker(makeCtx(container), baseEnv());

    await durableObject.stop('devin-1', 'suspended');

    expect(container.running).toBe(true);
    expect(container.destroyed).toBe(0);
    expect(container.events).toEqual([]);
  });

  it('deletes the checkpoint when a session is terminated', async () => {
    const container = fakeContainer(false);
    const env = baseEnv();
    const durableObject = newTestDevinWorker(makeCtx(container), env);

    await durableObject.stop('devin-1', 'terminated');

    expect(env.DEVIN_CHECKPOINTS.delete).toHaveBeenCalledWith(
      'sessions/devin-1.tar.zst'
    );
  });

  it('keeps the checkpoint when terminating a container fails', async () => {
    const container = fakeContainer(true, new Error('destroy failed'));
    const env = baseEnv();
    const durableObject = newTestDevinWorker(makeCtx(container), env);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(durableObject.stop('devin-1', 'terminated')).rejects.toThrow(
      'destroy failed'
    );

    expect(container.running).toBe(true);
    expect(env.DEVIN_CHECKPOINTS.delete).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('is idempotent when stop is called for an already-stopped container', async () => {
    const container = fakeContainer(false);
    const durableObject = newTestDevinWorker(makeCtx(container), baseEnv());

    await durableObject.stop('devin-1', 'suspended');

    expect(container.destroyed).toBe(0);
    expect(container.running).toBe(false);
  });

  it('recovers from DO eviction because the Worker passes session data again', async () => {
    const container = fakeContainer(false);
    const env = baseEnv();

    await newTestDevinWorker(makeCtx(container), env).ensureRunning(
      'devin-1',
      'pool-1',
      'acceptor-1'
    );
    await newTestDevinWorker(makeCtx(container), env).ensureRunning(
      'devin-1',
      'pool-1',
      'acceptor-1'
    );

    expect(container.starts).toHaveLength(1);
    expect(container.running).toBe(true);
  });

  it('restarts after a container dies when the next reconcile still says running', async () => {
    const container = fakeContainer(false);
    const stub = newTestDevinWorker(makeCtx(container), baseEnv());

    await stub.ensureRunning('devin-1', 'pool-1', 'acceptor-1');
    container.running = false; // simulate the CLI/container exiting independently
    await stub.ensureRunning('devin-1', 'pool-1', 'acceptor-1');

    expect(container.starts).toHaveLength(2);
    expect(container.running).toBe(true);
  });
});
