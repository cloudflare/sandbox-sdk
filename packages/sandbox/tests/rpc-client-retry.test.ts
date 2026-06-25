import type { ErrorResponse } from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
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

interface CapturedRPCMain {
  commands: {
    execute: (
      command: string,
      sessionId: string,
      options?: { timeoutMs?: number }
    ) => Promise<unknown>;
  };
}

const captured: {
  options: CapturedOptions[];
  setRetryTimeoutCalls: number[];
  rpcMain: CapturedRPCMain;
} = {
  options: [],
  setRetryTimeoutCalls: [],
  rpcMain: {
    commands: {
      execute: async () => ({ success: true })
    }
  }
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
      return captured.rpcMain;
    }
    async connect() {}
  }
}));

import {
  ContainerControlClient,
  translateRPCError
} from '../src/container-control/client';
import { OperationInterruptedError, SandboxError } from '../src/errors/classes';

describe('ContainerControlClient retry timeout wiring', () => {
  beforeEach(() => {
    captured.options.length = 0;
    captured.setRetryTimeoutCalls.length = 0;
    captured.rpcMain = {
      commands: {
        execute: async () => ({ success: true })
      }
    };
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

  it('attaches operation context to interrupted RPC method calls', async () => {
    captured.rpcMain.commands.execute = async () => {
      throw new Error('RPC session was shut down by disposing the main stub');
    };
    const client = new ContainerControlClient({
      stub: { fetch: vi.fn() }
    });

    await expect(
      client.commands.execute('echo ready', 'default')
    ).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: {
        reason: 'transport_disposed',
        operation: 'commands.execute',
        phase: 'rpc_call',
        admitted: 'unknown',
        retryable: false
      }
    });
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

describe('translateRPCError', () => {
  it('maps session-disposed RPC errors to OperationInterruptedError with operation context', () => {
    let caughtError: unknown;
    try {
      translateRPCError(
        new Error('RPC session was shut down by disposing the main stub'),
        { operation: 'commands.execute' }
      );
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(OperationInterruptedError);
    expect((caughtError as OperationInterruptedError).code).toBe(
      ErrorCode.OPERATION_INTERRUPTED
    );
    expect((caughtError as OperationInterruptedError).context).toMatchObject({
      reason: 'transport_disposed',
      operation: 'commands.execute',
      phase: 'rpc_call',
      admitted: 'unknown',
      retryable: false
    });
  });

  it.each([
    ['Peer closed WebSocket: 1006 gone'],
    ['WebSocket connection failed.']
  ])(
    'maps in-flight transport loss %s to OperationInterruptedError with operation context',
    (message) => {
      let caughtError: unknown;
      try {
        translateRPCError(new Error(message), {
          operation: 'commands.execute'
        });
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(OperationInterruptedError);
      expect((caughtError as OperationInterruptedError).code).toBe(
        ErrorCode.OPERATION_INTERRUPTED
      );
      expect((caughtError as OperationInterruptedError).context).toMatchObject({
        reason: 'runtime_replaced',
        operation: 'commands.execute',
        phase: 'rpc_call',
        admitted: 'unknown',
        retryable: false
      });
    }
  );

  it('re-throws SandboxError subclasses without wrapping as RPCTransportError', () => {
    const originalError = new SandboxError({
      code: ErrorCode.BACKUP_RESTORE_FAILED,
      message: 'Restore interrupted',
      context: { dir: '/workspace', backupId: 'bk-1' },
      httpStatus: 500,
      timestamp: new Date().toISOString()
    } as ErrorResponse<{ dir: string; backupId: string }>);

    let caughtError: unknown;
    try {
      translateRPCError(originalError);
    } catch (e) {
      caughtError = e;
    }

    // The same instance must be re-thrown unchanged, not a freshly
    // constructed error that loses context or changes identity.
    expect(caughtError).toBe(originalError);
    expect((caughtError as Error).constructor.name).not.toBe(
      'RPCTransportError'
    );
  });
});
