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

import {
  ContainerControlClient,
  translateRPCError
} from '../src/container-control/client';
import { SandboxError } from '../src/errors/classes';

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

describe('translateRPCError', () => {
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
