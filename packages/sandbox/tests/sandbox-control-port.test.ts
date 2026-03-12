import { DEFAULT_CONTROL_PORT } from '@repo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('exposes port via getControlPort()', () => {
    const sandbox = new Sandbox(createMockCtx(), {
      SANDBOX_CONTROL_PORT: '9500'
    });
    expect(sandbox.getControlPort()).toBe(9500);
  });
});

describe('connect() with async getControlPort', () => {
  it('resolves control port and allows valid user ports', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response('ok'))
    };
    const getControlPort = vi.fn().mockResolvedValue(9500);

    const wsConnect = connect(mockStub, getControlPort);
    const request = new Request('http://localhost/test');

    await wsConnect(request, 8080);

    expect(getControlPort).toHaveBeenCalled();
    expect(mockStub.fetch).toHaveBeenCalled();
  });

  it('rejects the control port', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response('ok'))
    };
    const getControlPort = vi.fn().mockResolvedValue(9500);

    const wsConnect = connect(mockStub, getControlPort);
    const request = new Request('http://localhost/test');

    await expect(wsConnect(request, 9500)).rejects.toThrow(SecurityError);
    expect(mockStub.fetch).not.toHaveBeenCalled();
  });

  it('allows port 3000 when control port is custom', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response('ok'))
    };
    const getControlPort = vi.fn().mockResolvedValue(9500);

    const wsConnect = connect(mockStub, getControlPort);
    const request = new Request('http://localhost/test');

    await wsConnect(request, 3000);

    expect(mockStub.fetch).toHaveBeenCalled();
  });
});
