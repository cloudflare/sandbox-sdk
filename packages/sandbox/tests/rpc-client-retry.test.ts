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
} = {
  options: []
};

vi.mock('../src/container-control/connection', () => ({
  ContainerControlConnection: class {
    constructor(options: CapturedOptions) {
      captured.options.push(options);
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

import {
  ContainerControlClient,
  translateRPCError
} from '../src/container-control/client';

describe('translateRPCError operation interruption mapping', () => {
  function translateWithOperation(error: Error): never {
    return (
      translateRPCError as (
        error: unknown,
        context: { operation: string }
      ) => never
    )(error, { operation: 'processes.start' });
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
      let thrown: unknown;
      try {
        translateWithOperation(new Error(message));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        name: 'OperationInterruptedError',
        code: 'OPERATION_INTERRUPTED',
        context: expect.objectContaining({
          reason,
          operation: 'processes.start',
          admitted: 'unknown',
          retryable: false
        })
      });
      expect(
        (thrown as { context: Record<string, unknown> }).context
      ).not.toHaveProperty('phase');
    }
  );
});

describe('ContainerControlClient retry timeout wiring', () => {
  beforeEach(() => {
    captured.options.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes retryTimeoutMs through to ContainerControlConnection', async () => {
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() },
      retryTimeoutMs: 75_000
    });

    await client.connect();

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0].retryTimeoutMs).toBe(75_000);
  });

  it('omits retryTimeoutMs when not configured (lets the connection apply its default)', async () => {
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() }
    });

    await client.connect();

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0].retryTimeoutMs).toBeUndefined();
  });
});
