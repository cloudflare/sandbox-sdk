import type {
  PortWatchEvent,
  ProcessLogEvent,
  ProcessStatus
} from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError,
  RPCTransportError
} from '../src';
import { createSandboxProcess } from '../src/processes';
import type {
  ProcessPullSubscriptionRPC,
  ProcessRPCDescriptor
} from '../src/processes/rpc-types';

const now = new Date().toISOString();
const running: ProcessStatus = {
  id: 'ready-process',
  pid: 41,
  command: ['server'],
  state: 'running',
  startedAt: now
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function remote<T>(events?: T[]): ProcessPullSubscriptionRPC<T> {
  const remaining = events ? [...events] : undefined;
  return {
    next: vi.fn(async (): Promise<ReadableStreamReadResult<T>> => {
      if (remaining === undefined) return new Promise(() => {});
      const value = remaining.shift();
      return value === undefined
        ? { done: true, value: undefined }
        : { done: false, value };
    }),
    cancel: vi.fn(async () => undefined),
    [Symbol.dispose]: vi.fn()
  };
}

function exited(code: number): ProcessLogEvent {
  return {
    type: 'terminal',
    state: 'exited',
    cursor: 'exit',
    timestamp: now,
    exit: { code, signal: code === 143 ? 15 : undefined, timedOut: false }
  };
}

function descriptor(
  portRemote: ProcessPullSubscriptionRPC<PortWatchEvent>,
  logRemote: ProcessPullSubscriptionRPC<ProcessLogEvent>
): ProcessRPCDescriptor {
  return {
    id: running.id,
    pid: running.pid,
    capability: {
      status: vi.fn(async () => running),
      openLogs: vi.fn(async () => logRemote),
      openPortWatch: vi.fn(async () => portRemote),
      kill: vi.fn(async () => undefined)
    }
  };
}

function expectReleased(
  remoteSubscription: ProcessPullSubscriptionRPC<object>
): void {
  expect(remoteSubscription.cancel).toHaveBeenCalledTimes(1);
  expect(remoteSubscription[Symbol.dispose]).toHaveBeenCalledTimes(1);
}

describe('process readiness', () => {
  it('resolves a ready event and cancels both subscriptions exactly once', async () => {
    const port = remote<PortWatchEvent>([
      { type: 'watching', port: 8080 },
      { type: 'ready', port: 8080 }
    ]);
    const logs = remote<ProcessLogEvent>();
    const processDescriptor = descriptor(port, logs);

    await createSandboxProcess(processDescriptor).waitForPort(8080, {
      mode: 'http',
      path: '/health',
      status: 200,
      interval: 50
    });

    expect(processDescriptor.capability.openPortWatch).toHaveBeenCalledWith(
      8080,
      { mode: 'http', path: '/health', status: 200, interval: 50 }
    );
    expectReleased(port);
    expectReleased(logs);
  });

  it('rejects local timeout with ProcessReadyTimeoutError without kill', async () => {
    const port = remote<PortWatchEvent>();
    const logs = remote<ProcessLogEvent>();
    const processDescriptor = descriptor(port, logs);

    await expect(
      createSandboxProcess(processDescriptor).waitForPort(8080, { timeout: 1 })
    ).rejects.toBeInstanceOf(ProcessReadyTimeoutError);

    expect(processDescriptor.capability.kill).not.toHaveBeenCalled();
    expectReleased(port);
    expectReleased(logs);
  });

  it('times out while readiness subscription acquisition is pending', async () => {
    const pending = deferred<ProcessPullSubscriptionRPC<PortWatchEvent>>();
    const port = remote<PortWatchEvent>();
    const logs = remote<ProcessLogEvent>();
    const processDescriptor = descriptor(port, logs);
    processDescriptor.capability.openPortWatch = vi.fn(() => pending.promise);

    await expect(
      createSandboxProcess(processDescriptor).waitForPort(8080, { timeout: 1 })
    ).rejects.toBeInstanceOf(ProcessReadyTimeoutError);
    pending.resolve(port);
    await vi.waitFor(() => expectReleased(port));
    expect(processDescriptor.capability.openLogs).not.toHaveBeenCalled();
  });

  it('rejects authoritative numeric-signal exit before readiness', async () => {
    const port = remote<PortWatchEvent>();
    const logs = remote<ProcessLogEvent>([exited(143)]);

    await expect(
      createSandboxProcess(descriptor(port, logs)).waitForPort(8080)
    ).rejects.toBeInstanceOf(ProcessExitedBeforeReadyError);

    expectReleased(port);
    expectReleased(logs);
  });

  it('treats port subscription closure as transport failure', async () => {
    const port = remote<PortWatchEvent>([]);
    const logs = remote<ProcessLogEvent>();

    await expect(
      createSandboxProcess(descriptor(port, logs)).waitForPort(8080)
    ).rejects.toBeInstanceOf(RPCTransportError);

    expectReleased(port);
    expectReleased(logs);
  });
});
