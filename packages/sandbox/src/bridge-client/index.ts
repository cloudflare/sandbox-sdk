/**
 * @cloudflare/sandbox/bridge-client — typed capnweb client for the bridge
 * Worker's `GET /v1/rpc` WebSocket endpoint.
 *
 * One `BridgeClient` instance manages many sandboxes over a single
 * WebSocket. Each `client.sandbox(id)` call returns a typed handle whose
 * method invocations resolve a per-sandbox stub on the server (cached on
 * both ends) and forward the call.
 *
 * ```ts
 * import { createBridgeClient } from '@cloudflare/sandbox/bridge-client';
 *
 * const client = createBridgeClient({
 *   baseURL: 'https://bridge.example.com/v1',
 *   token: process.env.SANDBOX_API_KEY,
 * });
 *
 * const result = await client
 *   .sandbox('my-sandbox')
 *   .commands.execute('ls', sessionId);
 * await client.close();
 * ```
 *
 * Authentication is carried in `Sec-WebSocket-Protocol` (the only
 * upgrade-time header browsers can set) using the
 * `cloudflare-sandbox-bridge.bearer.<token>` subprotocol, so the same
 * client works in browsers, Bun, Node 22+, and Cloudflare Workers.
 */

import { newWebSocketRpcSession, type RpcStub } from 'capnweb';
import {
  BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX,
  type BridgeRPCAPI,
  type SandboxRPCAPI
} from '../bridge/rpc-types';

export type { BridgeRPCAPI, SandboxRPCAPI } from '../bridge/rpc-types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the bridge rejects the WebSocket upgrade with a non-101
 * status. The 401 case (missing or invalid bearer token) sets
 * `status = 401` so callers can distinguish auth failures from generic
 * transport problems.
 */
export class BridgeAuthError extends Error {
  override readonly name = 'BridgeAuthError';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Thrown when the WebSocket closes during the connect phase. */
export class BridgeConnectError extends Error {
  override readonly name = 'BridgeConnectError';
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface BridgeClientOptions {
  /**
   * Bridge base URL including the API route prefix. The client appends
   * `/rpc` to this and converts `http(s):` to `ws(s):` automatically.
   *
   * @example 'https://bridge.example.com/v1'
   * @example 'http://localhost:8787/v1'
   */
  baseURL: string;
  /**
   * Bearer token (the bridge's `SANDBOX_API_KEY`). Optional when the bridge
   * has auth disabled. Carried in `Sec-WebSocket-Protocol` because browser
   * `WebSocket` constructors cannot set arbitrary upgrade headers.
   */
  token?: string;
  /**
   * Override the global `WebSocket` constructor. Defaults to
   * `globalThis.WebSocket`. Tests inject an in-process pair; production
   * code should leave this unset.
   */
  WebSocket?: typeof WebSocket;
}

/**
 * Sandbox handle — structurally `SandboxRPCAPI`, but every method is
 * lazy: the bridge WebSocket is opened (and authenticated) on the first
 * call across any sandbox handle and reused for the lifetime of the
 * parent `BridgeClient`.
 */
export type SandboxHandle = SandboxRPCAPI;

export interface BridgeClient {
  /** Return a typed handle for the given sandbox. Lazy — no I/O until use. */
  sandbox(sandboxId?: string): SandboxHandle;
  /** Close the WebSocket and dispose the capnweb session. */
  close(): Promise<void>;
  /** `await using` syntax support. Identical to `close()`. */
  [Symbol.asyncDispose](): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a bridge client. No I/O happens until the caller invokes a method
 * on a sandbox handle.
 */
export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const maybeWebsocket =
    options.WebSocket ??
    (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!maybeWebsocket) {
    throw new Error(
      'No WebSocket implementation available. Pass one via the `WebSocket` option.'
    );
  }
  const WebSocketCtor: typeof WebSocket = maybeWebsocket;

  // Single connection state shared by every sandbox handle. Lazy — only
  // opened on the first RPC call.
  let connection: Connection | null = null;

  function getOrOpenConnection(): Connection {
    if (!connection) {
      connection = openConnection(options, WebSocketCtor);
      connection.bridgePromise.catch(() => {
        // Don't cache a permanently-rejected promise.
        connection = null;
      });
    }
    return connection;
  }

  // Per-sandbox stub cache. Each entry is the in-flight (or resolved)
  // capnweb promise returned by `bridgeStub.sandbox(id)`. Capnweb pipelines
  // method calls onto an unresolved promise, so caching here saves a round
  // trip per sandbox; a failed resolution is removed so the next call retries.
  // The cache type is loose because capnweb's stub typing wraps domain
  // getters in `RpcPromise` which doesn't structurally satisfy the plain
  // `SandboxRPCAPI` interface; runtime behaviour is the same.
  const sandboxCache = new Map<string, Promise<any>>();

  function getSandboxStub(sandboxId: string): Promise<any> {
    const cached = sandboxCache.get(sandboxId);
    if (cached) return cached;
    const fresh = getOrOpenConnection().bridgePromise.then((bridge) =>
      bridge.sandbox(sandboxId)
    );
    sandboxCache.set(sandboxId, fresh);
    fresh.catch(() => sandboxCache.delete(sandboxId));
    return fresh;
  }

  return {
    sandbox(sandboxId: string): SandboxHandle {
      return makeLazyHandle(() => getSandboxStub(sandboxId));
    },

    async close(): Promise<void> {
      sandboxCache.clear();
      const conn = connection;
      connection = null;
      if (conn) {
        try {
          conn.dispose();
        } catch {
          // best-effort
        }
      }
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await this.close();
    }
  };
}

/**
 * Build a `SandboxRPCAPI`-shaped Proxy whose method calls await the given
 * `getStub()` before forwarding. Domain access (`.commands`, `.files`, ...)
 * is itself a Proxy whose method calls forward to `stub[domain][method](...)`.
 *
 * Streaming methods (returning `ReadableStream`) work the same way — the
 * outer Promise resolves to the stream once capnweb hands it back.
 */
function makeLazyHandle(getStub: () => Promise<any>): SandboxHandle {
  const domainCache = new Map<string, any>();
  return new Proxy({} as SandboxHandle, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      // capnweb uses `then` detection to avoid auto-awaiting; the lazy
      // handle must not look thenable.
      if (prop === 'then') return undefined;
      // `.id` returns a primitive over capnweb, not a nested target. Forward
      // it directly as a Promise<string> rather than wrapping it in a
      // domain proxy.
      if (prop === 'id') {
        return getStub().then((stub) => stub.id);
      }
      let domain = domainCache.get(prop);
      if (!domain) {
        domain = makeLazyDomain(prop, getStub);
        domainCache.set(prop, domain);
      }
      return domain;
    }
  });
}

function makeLazyDomain(domainName: string, getStub: () => Promise<any>): any {
  const methodCache = new Map<string, any>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        // capnweb uses `then` detection to avoid auto-awaiting; we never
        // want a domain handle to look thenable.
        if (prop === 'then') return undefined;
        let fn = methodCache.get(prop);
        if (!fn) {
          fn = (...args: unknown[]) =>
            getStub().then((stub) => {
              const target = (stub as any)[domainName];
              if (!target || typeof target[prop] !== 'function') {
                throw new TypeError(
                  `SandboxRPCAPI method ${domainName}.${prop} is not available`
                );
              }
              return target[prop](...args);
            });
          methodCache.set(prop, fn);
        }
        return fn;
      }
    }
  );
}

interface Connection {
  /** Resolves to the top-level `BridgeRPCAPI` stub once the WS is open. */
  bridgePromise: Promise<RpcStub<BridgeRPCAPI>>;
  dispose(): void;
}

function openConnection(
  options: BridgeClientOptions,
  WebSocketCtor: typeof WebSocket
): Connection {
  const wsUrl = buildRpcUrl(options);
  const protocols = options.token
    ? [`${BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX}${options.token}`]
    : undefined;

  const ws = protocols
    ? new WebSocketCtor(wsUrl, protocols)
    : new WebSocketCtor(wsUrl);

  let bridge: RpcStub<BridgeRPCAPI> | null = null;

  const bridgePromise = new Promise<RpcStub<BridgeRPCAPI>>(
    (resolve, reject) => {
      let settled = false;
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        bridge = newWebSocketRpcSession<BridgeRPCAPI>(ws as WebSocket);
        resolve(bridge);
      };
      const onClose = (ev: CloseEvent) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Browsers and Bun don't surface the upgrade response's HTTP
        // status on a failed WebSocket connection — we just see a 1002/1006
        // close. Probe the URL via fetch() to recover the real status so
        // 401s become a typed `BridgeAuthError` rather than a generic
        // transport error.
        probeAuthStatus(options)
          .then((status) => {
            if (status === 401) {
              reject(new BridgeAuthError('Unauthorized', 401));
            } else if (ev.code === 4401 || /401/.test(ev.reason ?? '')) {
              reject(new BridgeAuthError(ev.reason || 'Unauthorized', 401));
            } else {
              reject(
                new BridgeConnectError(
                  ev.reason || `WebSocket closed (code=${ev.code})`,
                  ev.code
                )
              );
            }
          })
          .catch(() => {
            reject(
              new BridgeConnectError(
                ev.reason || `WebSocket closed (code=${ev.code})`,
                ev.code
              )
            );
          });
      };
      // `error` always precedes `close`. Wait for `close` to read the code.
      const onError = () => {};
      function cleanup() {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('close', onClose as EventListener);
        ws.removeEventListener('error', onError);
      }
      ws.addEventListener('open', onOpen);
      ws.addEventListener('close', onClose as EventListener);
      ws.addEventListener('error', onError);
    }
  );

  return {
    bridgePromise,
    dispose() {
      try {
        if (bridge) (bridge as unknown as Disposable)[Symbol.dispose]?.();
      } catch {
        // already disposed
      }
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  };
}

/**
 * Probe the RPC endpoint with a non-upgrade `fetch()` to recover the HTTP
 * status that browsers and Bun hide behind a generic 1002/1006 WebSocket
 * close. We send the same subprotocol the WS attempt used (in a header so
 * `fetch` doesn't strip it) and an `Upgrade: websocket` header so the
 * route's auth middleware runs the real bearer check.
 *
 * Returns the response status, or 0 if the probe itself fails (e.g.
 * network unreachable). Callers should treat 0 as "unknown" and fall
 * back to the close-event signal.
 */
async function probeAuthStatus(options: BridgeClientOptions): Promise<number> {
  const httpUrl = `${options.baseURL.replace(/\/$/, '')}/rpc`;
  const headers: Record<string, string> = {
    Upgrade: 'websocket',
    Connection: 'Upgrade'
  };
  if (options.token) {
    headers['Sec-WebSocket-Protocol'] =
      `${BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX}${options.token}`;
  }
  try {
    const res = await fetch(httpUrl, { method: 'GET', headers });
    return res.status;
  } catch {
    return 0;
  }
}

function buildRpcUrl(options: BridgeClientOptions): string {
  const base = options.baseURL.replace(/\/$/, '');
  const wsBase = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/rpc`;
}
