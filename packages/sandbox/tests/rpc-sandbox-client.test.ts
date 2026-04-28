import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verifies the RPC client's busy/idle bookkeeping — specifically that a
 * streaming RPC return (modeled by elevated capnweb stats sticking around
 * after the call promise has resolved) keeps `onActivity` firing past
 * `sleepAfter` and only fires `onSessionIdle` once stats return to baseline.
 *
 * We mock ContainerConnection so we can drive `getStats()` directly. The
 * test never actually opens a WebSocket.
 */

let stats = { imports: 1, exports: 1 };
let connected = true;
const disconnects: number[] = [];

vi.mock('../src/container-connection', () => ({
  ContainerConnection: class {
    isConnected() {
      return connected;
    }
    getStats() {
      return stats;
    }
    disconnect() {
      connected = false;
      disconnects.push(Date.now());
    }
    rpc() {
      // Stub sub-clients so wrapStub() has something to Proxy. Tests in
      // this file don't actually invoke any RPC method.
      return new Proxy({}, { get: () => ({}) });
    }
    async connect() {}
  }
}));

import { RPCSandboxClient } from '../src/clients/rpc-sandbox-client';

describe('RPCSandboxClient busy/idle tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stats = { imports: 1, exports: 1 };
    connected = true;
    disconnects.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the session marked busy while a stream export is held', () => {
    const onActivity = vi.fn();
    const onSessionBusy = vi.fn();
    const onSessionIdle = vi.fn();

    const client = new RPCSandboxClient({
      stub: { fetch: vi.fn() },
      onActivity,
      onSessionBusy,
      onSessionIdle,
      busyPollIntervalMs: 1_000,
      idleDisconnectMs: 1_000
    });

    // Touching a sub-client constructs the connection and starts the poller.
    void client.commands;

    // Simulate executeStream returning a ReadableStream: capnweb has
    // allocated an export for the pipe, and it stays elevated for the
    // entire duration of the stream.
    stats = { imports: 1, exports: 2 };

    // Tick 1: idle -> busy edge.
    vi.advanceTimersByTime(1_000);
    expect(onSessionBusy).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(1);

    // Three more ticks while still streaming. No edge transitions, but
    // each tick must renew activity — this is what keeps the DO awake
    // past sleepAfter.
    vi.advanceTimersByTime(3_000);
    expect(onSessionBusy).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(4);

    // Stream finishes: stats fall back to the bootstrap baseline.
    stats = { imports: 1, exports: 1 };

    // Tick: busy -> idle edge. inflight gets decremented exactly once.
    vi.advanceTimersByTime(1_000);
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
    expect(onSessionBusy).toHaveBeenCalledTimes(1);

    // Idle disconnect timer fires after idleDisconnectMs.
    vi.advanceTimersByTime(1_000);
    expect(disconnects).toHaveLength(1);
  });

  it('fires onSessionIdle on explicit disconnect to avoid leaking inflight', () => {
    const onSessionBusy = vi.fn();
    const onSessionIdle = vi.fn();

    const client = new RPCSandboxClient({
      stub: { fetch: vi.fn() },
      onSessionBusy,
      onSessionIdle,
      busyPollIntervalMs: 1_000,
      idleDisconnectMs: 60_000
    });
    void client.commands;

    stats = { imports: 1, exports: 2 };
    vi.advanceTimersByTime(1_000);
    expect(onSessionBusy).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).not.toHaveBeenCalled();

    // Tearing down while busy must release the inflight slot, otherwise
    // the DO's counter stays elevated forever.
    client.disconnect();
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
  });

  it('releases inflight when the WebSocket drops while busy', () => {
    const onSessionBusy = vi.fn();
    const onSessionIdle = vi.fn();

    const client = new RPCSandboxClient({
      stub: { fetch: vi.fn() },
      onSessionBusy,
      onSessionIdle,
      busyPollIntervalMs: 1_000,
      idleDisconnectMs: 60_000
    });
    void client.commands;

    stats = { imports: 1, exports: 2 };
    vi.advanceTimersByTime(1_000);
    expect(onSessionBusy).toHaveBeenCalledTimes(1);

    // Container crash / WebSocket peer-close: connection reports
    // disconnected on the next poll.
    connected = false;
    vi.advanceTimersByTime(1_000);

    // The poller must observe the dead connection, fire onSessionIdle so
    // the DO's inflight counter unwinds, and tear down so it isn't
    // looping over a corpse forever.
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
    expect(disconnects).toHaveLength(1);

    // Subsequent ticks must be a no-op — if the poller fired again it
    // would attempt destroyConnection() repeatedly.
    vi.advanceTimersByTime(5_000);
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
    expect(disconnects).toHaveLength(1);
  });

  it('does not tear down a connection that has not finished its WebSocket upgrade', () => {
    // Simulate the upgrade still being in flight: isConnected() returns
    // false from the moment the connection is constructed until
    // doConnect() resolves. While in this state the deferred transport
    // is queueing sends — tearing the connection down would discard them.
    connected = false;

    const onSessionIdle = vi.fn();
    const client = new RPCSandboxClient({
      stub: { fetch: vi.fn() },
      onSessionIdle,
      busyPollIntervalMs: 1_000,
      idleDisconnectMs: 60_000
    });
    void client.commands;

    // Several poll ticks while the upgrade is still pending. Must not
    // dispose the connection — the deferred transport's queue is the
    // only thing standing between the user's RPC call and the wire.
    vi.advanceTimersByTime(5_000);
    expect(disconnects).toHaveLength(0);
    expect(onSessionIdle).not.toHaveBeenCalled();

    // Upgrade completes. From here on the poller treats subsequent
    // disconnections as real peer-gone events.
    connected = true;
    stats = { imports: 1, exports: 2 };
    vi.advanceTimersByTime(1_000); // observed busy

    connected = false;
    vi.advanceTimersByTime(1_000); // peer-gone — now we tear down
    expect(disconnects).toHaveLength(1);
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
  });
});

describe('translateRPCError', () => {
  // We import translateRPCError lazily here to avoid the top-level vi.mock
  // affecting test isolation. The function is a pure transform and does not
  // depend on ContainerConnection.
  async function loadFn() {
    const mod = await import('../src/clients/rpc-sandbox-client');
    return mod.translateRPCError;
  }

  async function loadErr() {
    return await import('../src/errors');
  }

  // -------------------------------------------------------------------------
  // Structured (container-side) errors
  // -------------------------------------------------------------------------

  it('translates JSON-encoded structured errors into typed SandboxErrors', async () => {
    const translateRPCError = await loadFn();
    const { FileNotFoundError } = await loadErr();
    const payload = JSON.stringify({
      code: 'FILE_NOT_FOUND',
      message: 'no such file',
      context: { path: '/missing' }
    });
    let thrown: unknown;
    try {
      translateRPCError(new Error(payload));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FileNotFoundError);
    expect((thrown as Error).message).toContain('no such file');
  });

  // -------------------------------------------------------------------------
  // Transport-level errors — each `kind` of RPCTransportError
  // -------------------------------------------------------------------------

  it('classifies "Peer closed WebSocket: <code> <reason>" as kind=peer_closed', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError, ErrorCode } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new Error('Peer closed WebSocket: 1006 Connection ended')
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    const err = thrown as InstanceType<typeof RPCTransportError>;
    expect(err.code).toBe(ErrorCode.RPC_TRANSPORT_ERROR);
    expect(err.kind).toBe('peer_closed');
    expect(err.context.closeCode).toBe(1006);
    expect(err.context.closeReason).toBe('Connection ended');
    expect(err.originalMessage).toBe(
      'Peer closed WebSocket: 1006 Connection ended'
    );
    expect(err.httpStatus).toBe(503);
  });

  it('handles peer_closed with no reason text', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('Peer closed WebSocket: 1006 '));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    const err = thrown as InstanceType<typeof RPCTransportError>;
    expect(err.kind).toBe('peer_closed');
    expect(err.context.closeCode).toBe(1006);
    expect(err.context.closeReason).toBeUndefined();
  });

  it('classifies "WebSocket connection failed" as kind=connection_failed', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('WebSocket connection failed'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'connection_failed'
    );
  });

  it('classifies "WebSocket upgrade failed: 502 Bad Gateway" as kind=upgrade_failed', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('WebSocket upgrade failed: 502 Bad Gateway'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'upgrade_failed'
    );
  });

  it('classifies "No WebSocket in upgrade response" as kind=upgrade_failed', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('No WebSocket in upgrade response'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'upgrade_failed'
    );
  });

  it('classifies any Error with name="TypeError" as kind=invalid_frame', async () => {
    // The dispatcher introspects error.name (preserved across the wire by
    // capnweb) rather than `instanceof TypeError`. This is robust to
    // cross-realm errors — a TypeError raised inside capnweb's serializer
    // would not satisfy `instanceof TypeError` in the SDK realm but will
    // still carry name="TypeError".
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new TypeError('Received non-string message from WebSocket.')
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    const err = thrown as InstanceType<typeof RPCTransportError>;
    expect(err.kind).toBe('invalid_frame');
    expect(err.context.errorName).toBe('TypeError');
  });

  it('classifies a name-only TypeError-shaped Error as kind=invalid_frame', async () => {
    // Cross-realm scenario: `instanceof TypeError` would return false, but
    // capnweb still ships the name across the wire. We trust the name.
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    const err = new Error('whatever');
    err.name = 'TypeError';
    let thrown: unknown;
    try {
      translateRPCError(err);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'invalid_frame'
    );
  });

  it('classifies SyntaxError as kind=protocol_error', async () => {
    // capnweb's readLoop calls JSON.parse on each incoming frame; a peer
    // that sends a non-JSON payload raises a SyntaxError that propagates
    // through abort() to every in-flight call.
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new SyntaxError('Unexpected token x in JSON at position 0')
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    const err = thrown as InstanceType<typeof RPCTransportError>;
    expect(err.kind).toBe('protocol_error');
    expect(err.context.errorName).toBe('SyntaxError');
    expect(err.suggestion).toContain('malformed');
  });

  it('does NOT misclassify a plain Error with the invalid_frame message as invalid_frame', async () => {
    // Now gated on error.name rather than instanceof. A plain Error with
    // the message but name="Error" stays as kind=unknown.
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new Error('Received non-string message from WebSocket.')
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'unknown'
    );
  });

  it('exposes errorName in context for diagnostic purposes', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('Peer closed WebSocket: 1006 gone'));
    } catch (e) {
      thrown = e;
    }
    expect(
      (thrown as InstanceType<typeof RPCTransportError>).context.errorName
    ).toBe('Error');
  });

  it('classifies capnweb session-disposed errors as kind=session_disposed', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();

    for (const message of [
      'RPC session was shut down by disposing the main stub',
      'RPC was canceled because the RpcPromise was disposed.'
    ]) {
      let thrown: unknown;
      try {
        translateRPCError(new Error(message));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RPCTransportError);
      expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
        'session_disposed'
      );
    }
  });

  it('falls back to kind=unknown for unrecognised Error.message strings', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('totally bizarre socket failure'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    const err = thrown as InstanceType<typeof RPCTransportError>;
    expect(err.kind).toBe('unknown');
    expect(err.originalMessage).toBe('totally bizarre socket failure');
  });

  it('treats valid-JSON-but-not-an-RPCErrorPayload as a transport error', async () => {
    // Valid JSON, but doesn't have the {code, message} shape we recognise.
    // Falls through to transport classification; with no message match, lands
    // in kind=unknown with the JSON string preserved as originalMessage.
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('{"foo":"bar"}'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'unknown'
    );
  });

  it('wraps non-Error values in RPCTransportError with kind=unknown', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    for (const value of ['boom', 42, undefined, null, { weird: true }]) {
      let thrown: unknown;
      try {
        translateRPCError(value);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RPCTransportError);
      const err = thrown as InstanceType<typeof RPCTransportError>;
      expect(err.kind).toBe('unknown');
      // The raw value is preserved as `cause` for diagnostics.
      expect(err.cause).toBe(value);
      // originalMessage is the String() coercion of the value.
      expect(err.context.originalMessage).toBe(String(value));
    }
  });

  it('produces an RPCTransportError that carries a helpful suggestion', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('Peer closed WebSocket: 1006 '));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect(
      (thrown as InstanceType<typeof RPCTransportError>).suggestion
    ).toContain('container');
  });

  it('preserves the underlying transport Error as `cause`', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    const original = new Error('Peer closed WebSocket: 1006 Connection ended');
    let thrown: unknown;
    try {
      translateRPCError(original);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as Error).cause).toBe(original);
  });

  it('exposes `cause` on toJSON output for logging', async () => {
    const translateRPCError = await loadFn();
    const original = new Error('WebSocket connection failed');
    let thrown: unknown;
    try {
      translateRPCError(original);
    } catch (e) {
      thrown = e;
    }
    const json = (thrown as { toJSON: () => Record<string, unknown> }).toJSON();
    expect(json.cause).toBe(original);
  });

  it('does not set `cause` on errors translated from JSON-encoded structured payloads', async () => {
    // The container-side errors flow through createErrorFromResponse without
    // an `options` argument, so `cause` stays unset (matching pre-fix
    // behaviour for that path).
    const translateRPCError = await loadFn();
    const payload = JSON.stringify({
      code: 'FILE_NOT_FOUND',
      message: 'no such file',
      context: { path: '/missing' }
    });
    let thrown: unknown;
    try {
      translateRPCError(new Error(payload));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).cause).toBeUndefined();
  });
});
