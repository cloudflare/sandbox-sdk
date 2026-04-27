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
