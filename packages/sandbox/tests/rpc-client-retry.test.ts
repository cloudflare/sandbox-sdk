import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verifies that `ContainerControlClient` plumbs the 503 retry budget
 * through to the underlying `ContainerControlConnection`. The actual retry
 * loop is exercised in `container-connection.test.ts`; here we only assert
 * the wiring.
 */

interface CapturedOptions {
  retryTimeoutMs?: number;
}

const captured: {
  options: CapturedOptions[];
  setRetryTimeoutCalls: number[];
} = {
  options: [],
  setRetryTimeoutCalls: []
};

vi.mock('../src/container-control/connection', () => ({
  ContainerControlConnection: class {
    constructor(options: CapturedOptions) {
      captured.options.push(options);
    }
    setRetryTimeoutMs(ms: number) {
      captured.setRetryTimeoutCalls.push(ms);
    }
    isConnected() {
      return false;
    }
    getStats() {
      return { imports: 1, exports: 1 };
    }
    disconnect() {}
    rpc() {
      return new Proxy({}, { get: () => ({}) });
    }
    async connect() {}
  }
}));

import { ContainerControlClient } from '../src/container-control/client';
import { translateRPCError } from '../src/container-control/errors';

describe('translateRPCError operation interruption mapping', () => {
  function translateWithOperation(error: Error): never {
    return (
      translateRPCError as (
        error: unknown,
        context: { operation: string }
      ) => never
    )(error, { operation: 'commands.execute' });
  }

  it.each([
    ['Peer closed WebSocket: 1006 runtime replaced', 'runtime_replaced'],
    ['WebSocket connection failed.', 'runtime_replaced'],
    [
      'RPC session was shut down by disposing the main stub',
      'transport_disposed'
    ]
  ])(
    'maps in-flight transport loss %s to OPERATION_INTERRUPTED',
    (message, reason) => {
      expect(() => translateWithOperation(new Error(message))).toThrowError(
        expect.objectContaining({
          name: 'OperationInterruptedError',
          code: 'OPERATION_INTERRUPTED',
          context: expect.objectContaining({
            reason,
            operation: 'commands.execute',
            phase: 'rpc_call',
            admitted: 'unknown',
            retryable: false
          })
        })
      );
    }
  );
});

describe('ContainerControlClient retry timeout wiring', () => {
  beforeEach(() => {
    captured.options.length = 0;
    captured.setRetryTimeoutCalls.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes retryTimeoutMs through to ContainerControlConnection', () => {
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() },
      retryTimeoutMs: 75_000
    });

    // Force connection construction by touching a sub-client.
    void client.commands;

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0].retryTimeoutMs).toBe(75_000);
  });

  it('omits retryTimeoutMs when not configured (lets the connection apply its default)', () => {
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() }
    });

    void client.commands;

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0].retryTimeoutMs).toBeUndefined();
  });

  it('forwards setRetryTimeoutMs() to the active connection', () => {
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() },
      retryTimeoutMs: 60_000
    });

    void client.commands;

    client.setRetryTimeoutMs(45_000);

    expect(captured.setRetryTimeoutCalls).toEqual([45_000]);
  });

  it('caches setRetryTimeoutMs() calls made before any connection is created', () => {
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() }
    });

    // No connection exists yet. The setter should still take effect once the
    // connection is created — either by stashing the value and applying it on
    // construction, or by applying it immediately if a connection is present.
    client.setRetryTimeoutMs(15_000);

    void client.commands;

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0].retryTimeoutMs).toBe(15_000);
  });
});
