/**
 * Tests for `createBridgeClient()` from `@cloudflare/sandbox/bridge-client`.
 *
 * One client manages many sandboxes over a single WebSocket. Lazy:
 * the socket is opened (and authenticated) on the first method call
 * across any sandbox handle. Subsequent calls reuse the same socket;
 * calling `client.sandbox(id)` twice returns proxies that resolve to
 * the same cached server-side stub.
 *
 * Tests run against the real bridge route via `handleRpcUpgrade()` and
 * an in-process WebSocket pair, so the same subprotocol auth and
 * capnweb wiring tested in `rpc.test.ts` is also exercised through the
 * public client surface.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRpcUpgrade } from '../src/bridge/rpc-api';
import {
  BridgeAuthError,
  createBridgeClient,
  type SandboxRPCAPI
} from '../src/bridge-client/index';
import { createMockEnv, createMockSandbox } from './bridge-test-helpers';

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

/**
 * Build a `WebSocket`-shaped factory that drives the upgrade through
 * `handleRpcUpgrade()` and adapts the resulting Workers WebSocket into
 * the EventTarget surface the client expects.
 */
function makeInProcessWebSocketFactory(
  env: Record<string, unknown>
): typeof WebSocket {
  // biome-ignore lint/complexity/useArrowFunction: must be `new`-able for the WebSocket constructor shape
  return function (url: string | URL, protocols?: string | string[]) {
    const wsUrl = typeof url === 'string' ? url : url.toString();
    const httpUrl = wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    const protoList = Array.isArray(protocols)
      ? protocols
      : protocols
        ? [protocols]
        : [];
    const headers: Record<string, string> = {
      Upgrade: 'websocket',
      Connection: 'Upgrade'
    };
    if (protoList.length > 0) {
      headers['Sec-WebSocket-Protocol'] = protoList.join(', ');
    }

    const listeners: Record<string, Set<(ev: unknown) => void>> = {};
    const target = {
      readyState: 0,
      protocol: '' as any,
      addEventListener(type: string, fn: (ev: unknown) => void) {
        let set = listeners[type];
        if (!set) {
          set = new Set();
          listeners[type] = set;
        }
        set.add(fn);
      },
      removeEventListener(type: string, fn: (ev: unknown) => void) {
        listeners[type]?.delete(fn);
      },
      send(data: string | ArrayBuffer): void {
        innerSend?.(data);
      },
      close(): void {
        innerClose?.();
      }
    };
    let innerSend: ((data: string | ArrayBuffer) => void) | null = null;
    let innerClose: (() => void) | null = null;

    function fire(type: string, ev: unknown) {
      for (const fn of listeners[type] ?? []) fn(ev);
    }

    queueMicrotask(() => {
      const request = new Request(httpUrl, { method: 'GET', headers });
      const res = handleRpcUpgrade(
        request,
        env as Parameters<typeof handleRpcUpgrade>[1],
        { sandboxBinding: 'Sandbox' }
      );
      if (res.status !== 101) {
        target.readyState = 3;
        fire('error', { message: `Upgrade failed: ${res.status}` });
        fire('close', {
          code: res.status === 401 ? 4401 : 4000 + res.status,
          reason: `Upgrade failed: ${res.status}`,
          wasClean: false
        });
        return;
      }
      const inner = (res as any).webSocket as WebSocket | undefined;
      if (!inner) {
        target.readyState = 3;
        fire('error', { message: 'No webSocket attached' });
        return;
      }
      inner.accept();
      target.readyState = 1;
      target.protocol = res.headers.get('Sec-WebSocket-Protocol') ?? '';
      innerSend = (data) => inner.send(data);
      innerClose = () => inner.close();
      inner.addEventListener('message', (e: MessageEvent) => {
        fire('message', { data: e.data });
      });
      inner.addEventListener('close', (e: CloseEvent) => {
        target.readyState = 3;
        fire('close', { code: e.code, reason: e.reason, wasClean: true });
      });
      inner.addEventListener('error', () => fire('error', {}));
      fire('open', {});
    });

    return target;
  } as unknown as typeof WebSocket;
}

describe('createBridgeClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('client.sandbox(id).utils.ping() opens the bridge and returns "pong"', async () => {
    const env = createMockEnv({ SANDBOX_API_KEY: 'secret-token' });
    const client = createBridgeClient({
      baseURL: 'http://localhost/v1',
      token: 'secret-token',
      WebSocket: makeInProcessWebSocketFactory(env)
    });
    try {
      const reply = await client.sandbox('test').utils.ping();
      expect(reply).toBe('pong');
    } finally {
      await client.close();
    }
  });

  it('connects with no subprotocol when token is omitted', async () => {
    const env = createMockEnv();
    const client = createBridgeClient({
      baseURL: 'http://localhost/v1',
      WebSocket: makeInProcessWebSocketFactory(env)
    });
    try {
      const reply = await client.sandbox('test').utils.ping();
      expect(reply).toBe('pong');
    } finally {
      await client.close();
    }
  });

  it('reuses a single WebSocket across calls and sandboxes', async () => {
    const env = createMockEnv();
    const base = makeInProcessWebSocketFactory(env);
    const calls: Array<[string, unknown]> = [];
    // biome-ignore lint/complexity/useArrowFunction: must be `new`-able for the WebSocket constructor shape
    const factory = function (url: string | URL, protocols?: unknown) {
      calls.push([typeof url === 'string' ? url : url.toString(), protocols]);
      return (base as any)(url, protocols);
    } as unknown as typeof WebSocket;
    const client = createBridgeClient({
      baseURL: 'http://localhost/v1',
      WebSocket: factory
    });
    try {
      await client.sandbox('alpha').utils.ping();
      await client.sandbox('alpha').utils.ping();
      await client.sandbox('beta').utils.ping();
      await client.sandbox('beta').utils.ping();
      // Only one socket regardless of sandbox count.
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('ws://localhost/v1/rpc');
    } finally {
      await client.close();
    }
  });

  it('rejects with BridgeAuthError when the token is wrong', async () => {
    const env = createMockEnv({ SANDBOX_API_KEY: 'secret-token' });
    const client = createBridgeClient({
      baseURL: 'http://localhost/v1',
      token: 'WRONG',
      WebSocket: makeInProcessWebSocketFactory(env)
    });
    try {
      await expect(client.sandbox('test').utils.ping()).rejects.toMatchObject({
        name: 'BridgeAuthError',
        status: 401
      });
    } finally {
      await client.close();
    }
  });

  it('builds the URL with `wss://` for an `https://` base', async () => {
    const env = createMockEnv();
    const recordedUrls: string[] = [];
    const baseFactory = makeInProcessWebSocketFactory(env);
    // biome-ignore lint/complexity/useArrowFunction: must be `new`-able for the WebSocket constructor shape
    const recordingFactory = function (url: string | URL, protocols?: unknown) {
      recordedUrls.push(typeof url === 'string' ? url : url.toString());
      return (baseFactory as any)(url, protocols);
    } as unknown as typeof WebSocket;

    const client = createBridgeClient({
      baseURL: 'https://bridge.example.com/v1/',
      WebSocket: recordingFactory
    });
    try {
      await client.sandbox('abc').utils.ping();
      expect(recordedUrls[0]).toBe('wss://bridge.example.com/v1/rpc');
    } finally {
      await client.close();
    }
  });

  it('client.close() and Symbol.asyncDispose tear down the connection', async () => {
    const env = createMockEnv();
    const client = createBridgeClient({
      baseURL: 'http://localhost/v1',
      WebSocket: makeInProcessWebSocketFactory(env)
    });
    await client.sandbox('alpha').utils.ping();
    await client.sandbox('beta').utils.ping();
    await client.close();
    // Idempotent: second close (via async dispose) must not throw.
    await (client as unknown as AsyncDisposable)[Symbol.asyncDispose]();
  });

  it('client.sandbox() (no id) gets a server-generated id back through .id', async () => {
    const env = createMockEnv();
    const client = createBridgeClient({
      baseURL: 'http://localhost/v1',
      WebSocket: makeInProcessWebSocketFactory(env)
    });
    try {
      const sb = client.sandbox();
      const id = await sb.id;
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[a-z2-7]{1,128}$/);
    } finally {
      await client.close();
    }
  });

  it('exposes every SandboxRPCAPI domain on a sandbox handle', async () => {
    const env = createMockEnv();
    const client = createBridgeClient({
      baseURL: 'http://localhost/v1',
      WebSocket: makeInProcessWebSocketFactory(env)
    });
    try {
      const sb: SandboxRPCAPI = client.sandbox('test');
      const domains = [
        'commands',
        'files',
        'processes',
        'ports',
        'git',
        'interpreter',
        'utils',
        'backup',
        'desktop',
        'watch'
      ] as const;
      for (const d of domains) {
        expect(sb[d]).toBeDefined();
      }
      // Sanity: actually invoke one to prove the bridge is open.
      expect(await sb.utils.ping()).toBe('pong');
    } finally {
      await client.close();
    }
  });

  // The auth-failure test above exercises BridgeAuthError; this no-op
  // import-bind makes sure the public class is exported as documented.
  it('BridgeAuthError is publicly exported', () => {
    expect(typeof BridgeAuthError).toBe('function');
  });
});
