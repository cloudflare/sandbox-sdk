import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verifies the RPC client's busy/idle bookkeeping — specifically that a
 * streaming RPC return (modeled by elevated capnweb stats sticking around
 * after the call promise has resolved) keeps `onActivity` firing past
 * `sleepAfter` and only fires `onSessionIdle` once stats return to baseline.
 *
 * We mock ContainerControlConnection so we can drive `getStats()` directly. The
 * test never actually opens a WebSocket.
 */

let stats = { imports: 1, exports: 1 };
let connected = true;
const disconnects: number[] = [];
let commandExecuteImpl: (...args: unknown[]) => unknown = () => ({
  exitCode: 0,
  stdout: '',
  stderr: ''
});
/**
 * onClose callbacks installed by `ContainerControlClient` on the active
 * mock connection. The client's `getConnection()` wires this so the WS
 * close/error listeners can fire teardown synchronously — in tests we
 * invoke it directly via {@link triggerPeerClose} to simulate the
 * runtime dispatching that event.
 */
const onCloseHandlers: Array<() => void> = [];

/**
 * Simulate the runtime firing a `close` / `error` event on the live
 * WebSocket: flip the mock's `connected` flag and fire whichever
 * `onClose` the client most recently installed. Returns whether a
 * handler was actually invoked.
 */
function triggerPeerClose(): boolean {
  connected = false;
  const handler = onCloseHandlers.pop();
  if (!handler) return false;
  handler();
  return true;
}

vi.mock('../src/container-control/connection', () => ({
  ContainerControlConnection: class {
    constructor(options: { onClose?: () => void } = {}) {
      if (options.onClose) onCloseHandlers.push(options.onClose);
    }
    isConnected() {
      return connected;
    }
    isConnecting() {
      return false;
    }
    async whenSettled() {}
    getStats() {
      return stats;
    }
    disconnect() {
      connected = false;
      disconnects.push(Date.now());
    }
    rpc() {
      return new Proxy(
        {
          commands: {
            execute: (...args: unknown[]) => commandExecuteImpl(...args)
          }
        },
        { get: (target, prop) => Reflect.get(target, prop) ?? {} }
      );
    }
    async connect() {}
  }
}));

import {
  ContainerControlClient,
  translateRPCError
} from '../src/container-control/client';

describe('ContainerControlClient busy/idle tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stats = { imports: 1, exports: 1 };
    connected = true;
    disconnects.length = 0;
    onCloseHandlers.length = 0;
    commandExecuteImpl = () => ({ exitCode: 0, stdout: '', stderr: '' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the session marked busy while a stream export is held', () => {
    const onActivity = vi.fn();
    const onSessionBusy = vi.fn();
    const onSessionIdle = vi.fn();

    const client = new ContainerControlClient({
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

    const client = new ContainerControlClient({
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

    const client = new ContainerControlClient({
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

    // Container crash / WebSocket peer-close: the connection's WS
    // close listener fires synchronously via the `onClose` callback
    // the client installed in `getConnection()`. This must release
    // the inflight slot and tear the connection down inside the same
    // turn of the event loop — no waiting on a poll tick.
    const fired = triggerPeerClose();
    expect(fired).toBe(true);
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
    expect(disconnects).toHaveLength(1);

    // Subsequent poll ticks must be a no-op — `this.conn` has already
    // been nulled by `destroyConnection()`, so there's nothing left to
    // observe.
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
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() },
      onSessionIdle,
      busyPollIntervalMs: 1_000,
      idleDisconnectMs: 60_000
    });
    void client.commands;

    // Several poll ticks while the upgrade is still pending. Must not
    // dispose the connection — the deferred transport's queue is the
    // only thing standing between the user's RPC call and the wire.
    // The poller now treats `!isConnected()` as 'upgrade in progress'
    // unconditionally; peer-disconnect teardown comes through onClose.
    vi.advanceTimersByTime(5_000);
    expect(disconnects).toHaveLength(0);
    expect(onSessionIdle).not.toHaveBeenCalled();

    // Upgrade completes; the session goes busy.
    connected = true;
    stats = { imports: 1, exports: 2 };
    vi.advanceTimersByTime(1_000); // observed busy

    // Peer goes away. The WS close listener fires `onClose`, which
    // tears the connection down synchronously without depending on
    // the poller observing anything.
    const fired = triggerPeerClose();
    expect(fired).toBe(true);
    expect(disconnects).toHaveLength(1);
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
  });

  it('does not idle-disconnect while an RPC method promise is pending even when stats look idle', async () => {
    let resolveExecute!: (value: unknown) => void;
    commandExecuteImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExecute = resolve;
        })
    );

    const onActivity = vi.fn();
    const onSessionBusy = vi.fn();
    const onSessionIdle = vi.fn();

    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() },
      onActivity,
      onSessionBusy,
      onSessionIdle,
      busyPollIntervalMs: 1_000,
      idleDisconnectMs: 1_000
    });

    const pending = client.commands.execute('sleep 10', 'default');

    // Reproduce the race from sandbox-sdk#794: capnweb stats can report the
    // bootstrap baseline while the method promise is still pending. The old
    // implementation treated that as idle, armed the 1s disconnect timer, and
    // disposed the main stub while the operation was still in flight.
    stats = { imports: 1, exports: 1 };

    vi.advanceTimersByTime(5_000);
    expect(disconnects).toHaveLength(0);
    expect(onSessionBusy).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).not.toHaveBeenCalled();

    resolveExecute({ exitCode: 0, stdout: '', stderr: '' });
    await pending;
    await Promise.resolve();

    expect(onSessionIdle).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(disconnects).toHaveLength(1);
  });
});

describe('translateRPCError', () => {
  async function loadFn() {
    return translateRPCError;
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

  it('translates errors with propagated `code` / `details` props into typed SandboxErrors', async () => {
    // capnweb >= 0.8.0 preserves own enumerable properties on thrown objects.
    // Containers throw a ServiceError-shaped object with `code` and `details`.
    const translateRPCError = await loadFn();
    const { FileNotFoundError } = await loadErr();
    const err = Object.assign(new Error('no such file'), {
      code: 'FILE_NOT_FOUND',
      details: { path: '/missing' }
    });
    let thrown: unknown;
    try {
      translateRPCError(err);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FileNotFoundError);
    expect((thrown as Error).message).toContain('no such file');
    expect(
      (thrown as { errorResponse: { context: Record<string, unknown> } })
        .errorResponse.context.path
    ).toBe('/missing');
  });

  it('tolerates a propagated `code` with no `details` (defaults to empty context)', async () => {
    const translateRPCError = await loadFn();
    const { FileNotFoundError } = await loadErr();
    const err = Object.assign(new Error('no such file'), {
      code: 'FILE_NOT_FOUND'
    });
    let thrown: unknown;
    try {
      translateRPCError(err);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FileNotFoundError);
  });

  it('prefers propagated `code` over a JSON-encoded message body', async () => {
    // If a container ever sets both, the propagated property wins — it's the
    // authoritative source for new containers.
    const translateRPCError = await loadFn();
    const { FileNotFoundError } = await loadErr();
    const payload = JSON.stringify({
      code: 'COMMAND_NOT_FOUND',
      message: 'wrong',
      context: { command: 'nope' }
    });
    const err = Object.assign(new Error(payload), {
      code: 'FILE_NOT_FOUND',
      details: { path: '/missing' }
    });
    let thrown: unknown;
    try {
      translateRPCError(err);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FileNotFoundError);
  });

  it('ignores foreign `code` values that are not in the ErrorCode registry', async () => {
    // Node syscalls and other libraries decorate Errors with codes like
    // 'ENOENT'. Those must not be mistaken for a structured RPC error —
    // they fall through to transport classification.
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    const err = Object.assign(new Error('Peer closed WebSocket: 1006 '), {
      code: 'ENOENT'
    });
    let thrown: unknown;
    try {
      translateRPCError(err);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'peer_closed'
    );
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

  it('classifies "WebSocket connection failed." as kind=connection_failed', async () => {
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(new Error('WebSocket connection failed.'));
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

  it('omits `cause` from toJSON output (Error instances are not JSON-serializable)', async () => {
    // `cause` is intentionally absent from toJSON(): JSON.stringify(new Error())
    // emits `{}` because Error own properties are non-enumerable, so logging
    // `cause: <Error>` would surface a misleading empty object. The cause is
    // still reachable in-memory via `err.cause` for debugger/inspect.
    const translateRPCError = await loadFn();
    const original = new Error('WebSocket connection failed.');
    let thrown: unknown;
    try {
      translateRPCError(original);
    } catch (e) {
      thrown = e;
    }
    const json = (thrown as { toJSON: () => Record<string, unknown> }).toJSON();
    expect('cause' in json).toBe(false);
    // But the live instance still carries it for in-memory inspection.
    expect((thrown as Error).cause).toBe(original);
  });

  // -------------------------------------------------------------------------
  // Captured connection error preference
  // -------------------------------------------------------------------------

  it('prefers a captured connection error over a masking session_disposed transport error', async () => {
    const translateRPCError = await loadFn();
    const { ContainerUnavailableError } = await loadErr();
    // The typed error the connection layer captures for the platform
    // "no container instance" failure.
    const platformMessage =
      'There is no container instance that can be provided to this Durable Object, try again later';
    const connectionError = new ContainerUnavailableError({
      code: 'CONTAINER_UNAVAILABLE',
      message: platformMessage,
      context: {
        reason: 'no_container_instance_available',
        retryable: true,
        originalMessage: platformMessage
      },
      httpStatus: 503,
      timestamp: new Date().toISOString()
    });

    let thrown: unknown;
    try {
      translateRPCError(
        new Error('RPC session was shut down by disposing the main stub'),
        { operation: 'utils.createSession', connectionError }
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    const err = thrown as InstanceType<typeof ContainerUnavailableError>;
    expect(err.code).toBe('CONTAINER_UNAVAILABLE');
    expect(err.reason).toBe('no_container_instance_available');
    expect(err.context.retryable).toBe(true);
    expect(err.context.originalMessage).toBe(platformMessage);
  });

  it('ignores a captured connection error for container-side structured errors', async () => {
    const translateRPCError = await loadFn();
    const { FileNotFoundError, ContainerUnavailableError } = await loadErr();
    const connectionError = new ContainerUnavailableError({
      code: 'CONTAINER_UNAVAILABLE',
      message: 'no container',
      context: {
        reason: 'no_container_instance_available',
        retryable: true,
        originalMessage: 'no container'
      },
      httpStatus: 503,
      timestamp: new Date().toISOString()
    });
    const payload = JSON.stringify({
      code: 'FILE_NOT_FOUND',
      message: 'no such file',
      context: { path: '/missing' }
    });
    let thrown: unknown;
    try {
      translateRPCError(new Error(payload), {
        operation: 'files.readFile',
        connectionError
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FileNotFoundError);
  });

  it('falls back to the transport error when no connection error was captured', async () => {
    const translateRPCError = await loadFn();
    const { OperationInterruptedError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new Error('RPC session was shut down by disposing the main stub'),
        { operation: 'utils.createSession' }
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OperationInterruptedError);
  });

  it('maps to OPERATION_INTERRUPTED only when the session was established', async () => {
    const translateRPCError = await loadFn();
    const { OperationInterruptedError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new Error('RPC session was shut down by disposing the main stub'),
        { operation: 'utils.createSession', sessionEstablished: true }
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OperationInterruptedError);
  });

  it('surfaces a retryable ContainerUnavailableError (not a raw transport string) when the session never established', async () => {
    // The container never started, so the session never connected. A queued
    // call rejecting with capnweb's disposal message must NOT be reported as
    // an interruption (nothing was admitted) and must NOT leak the raw
    // capnweb string. Surface a clean, retryable CONTAINER_UNAVAILABLE that
    // preserves the transport message for diagnostics.
    const translateRPCError = await loadFn();
    const { ContainerUnavailableError, OperationInterruptedError } =
      await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new Error('RPC session was shut down by disposing the main stub'),
        { operation: 'utils.createSession', sessionEstablished: false }
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeInstanceOf(OperationInterruptedError);
    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    const err = thrown as InstanceType<typeof ContainerUnavailableError>;
    expect(err.code).toBe('CONTAINER_UNAVAILABLE');
    expect(err.reason).toBe('container_unreachable');
    expect(err.context.retryable).toBe(true);
    expect(err.context.originalMessage).toBe(
      'RPC session was shut down by disposing the main stub'
    );
    // The message states unavailability plainly — no raw capnweb string, and
    // no misleading "may be starting" hedge (the container was never reached).
    expect((err as Error).message).not.toContain('disposing the main stub');
    expect((err as Error).message).not.toContain('starting');
  });

  it('does not synthesize CONTAINER_UNAVAILABLE for a never-established non-teardown transport error', async () => {
    // An invalid-frame / protocol error is not a teardown-family kind, so it
    // should still surface as the transport error rather than being
    // reclassified as container-unavailable.
    const translateRPCError = await loadFn();
    const { RPCTransportError } = await loadErr();
    let thrown: unknown;
    try {
      translateRPCError(
        new TypeError('Received non-string message from WebSocket.'),
        { operation: 'utils.createSession', sessionEstablished: false }
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RPCTransportError);
    expect((thrown as InstanceType<typeof RPCTransportError>).kind).toBe(
      'invalid_frame'
    );
  });

  it('still prefers a captured connection error even when the session never established', async () => {
    const translateRPCError = await loadFn();
    const { ContainerUnavailableError } = await loadErr();
    const connectionError = new ContainerUnavailableError({
      code: 'CONTAINER_UNAVAILABLE',
      message: 'no instance',
      context: {
        reason: 'no_container_instance_available',
        retryable: true,
        originalMessage: 'no instance'
      },
      httpStatus: 503,
      timestamp: new Date().toISOString()
    });
    let thrown: unknown;
    try {
      translateRPCError(
        new Error('RPC session was shut down by disposing the main stub'),
        {
          operation: 'utils.createSession',
          connectionError,
          sessionEstablished: false
        }
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
  });

  it('prefers a structured (non-instanceof) CONTAINER_UNAVAILABLE connection error over the disposal error', async () => {
    // Reproduces the masked failure: a queued createSession rejects with
    // capnweb's disposal message, and the connection captured a *structured*
    // but cross-realm error-like object (not an instanceof SandboxError). It
    // must still surface as ContainerUnavailableError, not
    // OperationInterruptedError.
    const translateRPCError = await loadFn();
    const { ContainerUnavailableError } = await loadErr();
    const connectionError = {
      name: 'Error',
      code: 'CONTAINER_UNAVAILABLE',
      message:
        'There is no container instance that can be provided to this Durable Object, try again later',
      context: {
        reason: 'no_container_instance_available',
        retryable: true,
        originalMessage:
          'There is no container instance that can be provided to this Durable Object, try again later'
      }
    };
    let thrown: unknown;
    try {
      translateRPCError(
        new Error('RPC session was shut down by disposing the main stub'),
        { operation: 'utils.createSession', connectionError }
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    const err = thrown as InstanceType<typeof ContainerUnavailableError>;
    expect(err.code).toBe('CONTAINER_UNAVAILABLE');
    expect(err.reason).toBe('no_container_instance_available');
    expect(err.context.retryable).toBe(true);
  });

  it('rehydrates a structured connection error carried in `details`', async () => {
    const translateRPCError = await loadFn();
    const { ContainerUnavailableError } = await loadErr();
    const connectionError = {
      code: 'CONTAINER_UNAVAILABLE',
      message: 'no instance',
      details: {
        reason: 'max_container_instances_exceeded',
        retryable: true
      }
    };
    let thrown: unknown;
    try {
      translateRPCError(new Error('WebSocket connection failed.'), {
        operation: 'utils.createSession',
        connectionError
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    expect(
      (thrown as InstanceType<typeof ContainerUnavailableError>).reason
    ).toBe('max_container_instances_exceeded');
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
