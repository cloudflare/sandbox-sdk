import { DEFAULT_CONTROL_PORT } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: any;
    env: any;
    defaultPort?: number;
    envVars: Record<string, string> = {};
    sleepAfter: string | number = '10m';
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch() {
      return new Response('mock');
    }
    async containerFetch() {
      return new Response('mock');
    }
    async getState() {
      return { status: 'healthy' };
    }
    async startAndWaitForPorts() {}
    renewActivityTimeout() {}
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn((req: Request) => req)
  };
});

import { connect, Sandbox } from '../src/sandbox';
import { SecurityError } from '../src/security';

function createMockCtx() {
  return {
    storage: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue(new Map())
    },
    blockConcurrencyWhile: vi
      .fn()
      .mockImplementation(<T>(cb: () => Promise<T>): Promise<T> => cb()),
    waitUntil: vi.fn(),
    id: {
      toString: () => 'test-id',
      equals: vi.fn(),
      name: 'test'
    }
  } as unknown as ConstructorParameters<typeof Sandbox>[0];
}

describe('Sandbox control port configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to DEFAULT_CONTROL_PORT when env var is not set', () => {
    const sandbox = new Sandbox(createMockCtx(), {});
    expect(sandbox.defaultPort).toBe(DEFAULT_CONTROL_PORT);
  });

  it('reads SANDBOX_CONTROL_PORT from env', () => {
    const sandbox = new Sandbox(createMockCtx(), {
      SANDBOX_CONTROL_PORT: '9500'
    });
    expect(sandbox.defaultPort).toBe(9500);
  });

  it('falls back to default for non-numeric SANDBOX_CONTROL_PORT', () => {
    const sandbox = new Sandbox(createMockCtx(), {
      SANDBOX_CONTROL_PORT: 'abc'
    });
    expect(sandbox.defaultPort).toBe(DEFAULT_CONTROL_PORT);
  });

  it('propagates port to container via envVars', () => {
    const sandbox = new Sandbox(createMockCtx(), {
      SANDBOX_CONTROL_PORT: '9500'
    });
    expect(sandbox.envVars.SANDBOX_CONTROL_PORT).toBe('9500');
  });

  it('propagates default port to container via envVars', () => {
    const sandbox = new Sandbox(createMockCtx(), {});
    expect(sandbox.envVars.SANDBOX_CONTROL_PORT).toBe(
      String(DEFAULT_CONTROL_PORT)
    );
  });
});

describe('connect() with range-only validation', () => {
  let mockStub: { fetch: ReturnType<typeof vi.fn> };
  let wsConnect: ReturnType<typeof connect>;
  let request: Request;

  beforeEach(() => {
    mockStub = { fetch: vi.fn().mockResolvedValue(new Response('ok')) };
    wsConnect = connect(mockStub);
    request = new Request('http://localhost/test');
  });

  it('allows any port in valid range including DEFAULT_CONTROL_PORT', async () => {
    await wsConnect(request, 8080);
    expect(mockStub.fetch).toHaveBeenCalled();

    mockStub.fetch.mockClear();
    // Control port passes at proxy level — DO validates authoritatively
    await wsConnect(request, DEFAULT_CONTROL_PORT);
    expect(mockStub.fetch).toHaveBeenCalled();
  });

  it('rejects privileged ports (< 1024)', async () => {
    await expect(wsConnect(request, 80)).rejects.toThrow(SecurityError);
    expect(mockStub.fetch).not.toHaveBeenCalled();
  });

  it('rejects out-of-range ports', async () => {
    await expect(wsConnect(request, 65536)).rejects.toThrow(SecurityError);
    expect(mockStub.fetch).not.toHaveBeenCalled();
  });

  it('rejects non-integer ports', async () => {
    await expect(wsConnect(request, 3.5)).rejects.toThrow(SecurityError);
    expect(mockStub.fetch).not.toHaveBeenCalled();
  });
});

describe('WebSocket port validation in fetch() (header-based)', () => {
  let sandbox: Sandbox;
  let mockCtx: any;
  let parentFetch: ReturnType<typeof vi.spyOn>;

  function wsRequest(path: string, targetPort?: string): Request {
    const headers: Record<string, string> = {
      Upgrade: 'websocket',
      Connection: 'upgrade'
    };
    if (targetPort !== undefined) {
      headers['cf-container-target-port'] = targetPort;
    }
    return new Request(`http://localhost${path}`, { headers });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCtx = createMockCtx();
    sandbox = new Sandbox(mockCtx, {});
    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });
    vi.spyOn(sandbox as any, 'getState').mockResolvedValue({
      status: 'healthy'
    });
    (sandbox as any).ctx.container = { running: true };
    parentFetch = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(sandbox)), 'fetch')
      .mockResolvedValue(new Response('ok'));
  });

  afterEach(() => {
    parentFetch?.mockRestore();
    vi.restoreAllMocks();
  });

  it('rejects header-switched WebSocket targeting the control port', async () => {
    const response = await sandbox.fetch(
      wsRequest('/ws', String(DEFAULT_CONTROL_PORT))
    );
    expect(response.status).toBe(403);
    expect(parentFetch).not.toHaveBeenCalled();
  });

  it('rejects header-switched WebSocket targeting a custom configured control port', async () => {
    const customCtx = createMockCtx();
    const customSandbox = new Sandbox(customCtx, {
      SANDBOX_CONTROL_PORT: '9500'
    });
    await vi.waitFor(() => {
      expect(customCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });
    vi.spyOn(customSandbox as any, 'getState').mockResolvedValue({
      status: 'healthy'
    });
    (customSandbox as any).ctx.container = { running: true };

    const response = await customSandbox.fetch(wsRequest('/ws', '9500'));
    expect(response.status).toBe(403);
  });

  it('rejects header-switched WebSocket to out-of-range port', async () => {
    const response = await sandbox.fetch(wsRequest('/ws', '80'));
    expect(response.status).toBe(403);
    expect(parentFetch).not.toHaveBeenCalled();
  });

  it('allows header-switched WebSocket to a valid user port', async () => {
    const response = await sandbox.fetch(wsRequest('/ws', '8080'));
    expect(response.status).toBe(200);
    expect(parentFetch).toHaveBeenCalled();
  });

  it('allows control-plane WebSocket without target-port header', async () => {
    const response = await sandbox.fetch(wsRequest('/ws/pty?sessionId=test'));
    expect(response.status).toBe(200);
    expect(parentFetch).toHaveBeenCalled();
  });

  it('strips malformed target-port header before forwarding to Container.fetch()', async () => {
    const response = await sandbox.fetch(wsRequest('/ws', '8080abc'));
    expect(response.status).toBe(200);
    expect(parentFetch).toHaveBeenCalled();

    // Malformed header must be stripped so Container.fetch() can't re-parse it
    const forwarded = parentFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.has('cf-container-target-port')).toBe(false);
  });
});

describe('Legacy port fallback (startWithLegacyFallback)', () => {
  let sandbox: Sandbox;
  let mockCtx: any;
  let startAndWaitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockCtx = createMockCtx();
    sandbox = new Sandbox(mockCtx, {});

    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    startAndWaitSpy = vi.spyOn(sandbox as any, 'startAndWaitForPorts');

    vi.spyOn(sandbox as any, 'getState').mockResolvedValue({
      status: 'unhealthy'
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds on configured port without fallback', async () => {
    startAndWaitSpy.mockResolvedValueOnce(undefined);

    const parentFetch = vi
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
        'containerFetch'
      )
      .mockResolvedValueOnce(new Response('ok'));

    const response = await sandbox.containerFetch(
      new Request('http://localhost/test'),
      {},
      DEFAULT_CONTROL_PORT
    );

    expect(startAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(startAndWaitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ports: DEFAULT_CONTROL_PORT })
    );
    expect(response.status).toBe(200);
    parentFetch.mockRestore();
  });

  it('falls back to port 3000 when control port fails and container is running', async () => {
    startAndWaitSpy
      .mockRejectedValueOnce(new Error('failed to verify port'))
      .mockResolvedValueOnce(undefined);

    (sandbox as any).ctx.container = { running: true };

    const parentFetch = vi
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
        'containerFetch'
      )
      .mockResolvedValueOnce(new Response('ok'));

    const response = await sandbox.containerFetch(
      new Request('http://localhost/test'),
      {},
      DEFAULT_CONTROL_PORT
    );

    expect(startAndWaitSpy).toHaveBeenCalledTimes(2);
    expect(startAndWaitSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ports: 3000 })
    );
    expect(sandbox.defaultPort).toBe(3000);
    expect(response.status).toBe(200);
    parentFetch.mockRestore();
  });

  it('throws original error when both ports fail', async () => {
    startAndWaitSpy
      .mockRejectedValueOnce(new Error('failed to verify port'))
      .mockRejectedValueOnce(new Error('legacy also failed'));

    (sandbox as any).ctx.container = { running: true };

    const response = await sandbox.containerFetch(
      new Request('http://localhost/test'),
      {},
      DEFAULT_CONTROL_PORT
    );

    expect(startAndWaitSpy).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { context: { error: string } };
    expect(body.context.error).toContain('failed to verify port');
  });

  it('skips fallback when container is not running', async () => {
    startAndWaitSpy.mockRejectedValueOnce(new Error('container did not start'));

    (sandbox as any).ctx.container = { running: false };

    const response = await sandbox.containerFetch(
      new Request('http://localhost/test'),
      {},
      DEFAULT_CONTROL_PORT
    );

    expect(startAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
  });

  it('skips fallback for non-control ports (preview URLs)', async () => {
    startAndWaitSpy.mockRejectedValueOnce(new Error('failed to verify port'));

    (sandbox as any).ctx.container = { running: true };

    const response = await sandbox.containerFetch(
      new Request('http://localhost/test'),
      8080
    );

    expect(startAndWaitSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ports: 8080 })
    );
    expect(response.status).toBe(503);
    expect(sandbox.defaultPort).toBe(DEFAULT_CONTROL_PORT);
  });

  it('skips fallback when configured port is already 3000', async () => {
    const ctx3000 = createMockCtx();
    const sandbox3000 = new Sandbox(ctx3000, {
      SANDBOX_CONTROL_PORT: '3000'
    });
    await vi.waitFor(() => {
      expect(ctx3000.blockConcurrencyWhile).toHaveBeenCalled();
    });

    const spy = vi
      .spyOn(sandbox3000 as any, 'startAndWaitForPorts')
      .mockRejectedValueOnce(new Error('failed to verify port'));

    vi.spyOn(sandbox3000 as any, 'getState').mockResolvedValue({
      status: 'unhealthy'
    });
    (sandbox3000 as any).ctx.container = { running: true };

    const response = await sandbox3000.containerFetch(
      new Request('http://localhost/test'),
      {},
      3000
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
  });

  it('remaps port for current request after fallback', async () => {
    startAndWaitSpy
      .mockRejectedValueOnce(new Error('failed to verify port'))
      .mockResolvedValueOnce(undefined);

    (sandbox as any).ctx.container = { running: true };

    const parentFetch = vi
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
        'containerFetch'
      )
      .mockResolvedValueOnce(new Response('ok'));

    await sandbox.containerFetch(
      new Request('http://localhost/test'),
      {},
      DEFAULT_CONTROL_PORT
    );

    expect(parentFetch).toHaveBeenCalledWith(expect.any(Request), 3000);
    parentFetch.mockRestore();
  });

  it('remaps custom configured port after fallback', async () => {
    const customCtx = createMockCtx();
    const customSandbox = new Sandbox(customCtx, {
      SANDBOX_CONTROL_PORT: '9500'
    });
    await vi.waitFor(() => {
      expect(customCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    const customStartSpy = vi.spyOn(
      customSandbox as any,
      'startAndWaitForPorts'
    );
    customStartSpy
      .mockRejectedValueOnce(new Error('failed to verify port'))
      .mockResolvedValueOnce(undefined);

    vi.spyOn(customSandbox as any, 'getState').mockResolvedValue({
      status: 'unhealthy'
    });
    (customSandbox as any).ctx.container = { running: true };

    const parentFetch = vi
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(customSandbox)),
        'containerFetch'
      )
      .mockResolvedValueOnce(new Response('ok'));

    await customSandbox.containerFetch(
      new Request('http://localhost/test'),
      {},
      9500
    );

    expect(parentFetch).toHaveBeenCalledWith(expect.any(Request), 3000);
    parentFetch.mockRestore();
  });
});
