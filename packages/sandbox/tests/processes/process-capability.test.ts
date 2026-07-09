import type {
  PortWatchSubscriptionAPI,
  ProcessLogEvent,
  ProcessLogSubscriptionAPI,
  ProcessStatus
} from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  OperationInterruptedError,
  RPCTransportError,
  StaleProcessHandleError
} from '../../src/errors';
import {
  type ProcessCapabilityControl,
  type ProcessCapabilityLifecycle,
  ProcessCapabilityTarget
} from '../../src/processes/process-capability';

const running: ProcessStatus = {
  id: 'p1',
  pid: 123,
  command: ['/bin/sleep', '10'],
  state: 'running',
  startedAt: new Date().toISOString()
};

function subscription<T>(events: T[] = []): {
  stream(): Promise<ReadableStream<T>>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
} {
  return {
    stream: vi.fn(
      async () =>
        new ReadableStream<T>({
          start(controller) {
            for (const event of events) controller.enqueue(event);
            controller.close();
          }
        })
    ),
    cancel: vi.fn(async () => undefined),
    [Symbol.dispose]: vi.fn()
  };
}

function host(status: ProcessStatus | null = running) {
  const logs = subscription() satisfies ProcessLogSubscriptionAPI;
  const ports = subscription() satisfies PortWatchSubscriptionAPI;
  const control: ProcessCapabilityControl = {
    getProcess: vi.fn(async () => status),
    openLogs: vi.fn(async () => logs),
    openPortWatch: vi.fn(async () => ports),
    kill: vi.fn(async () => undefined)
  };
  const lifecycle: ProcessCapabilityLifecycle = {
    runRead: async (_runtime, _operation, call) => call(control),
    runControl: async (_runtime, _operation, call) => call(control)
  };
  return { control, lifecycle };
}

describe('ProcessCapabilityTarget', () => {
  it('verifies id and pid before status and control operations', async () => {
    const testHost = host();
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    await expect(capability.status()).resolves.toEqual(running);
    await capability.kill(9);

    expect(testHost.control.getProcess).toHaveBeenCalledTimes(2);
    expect(testHost.control.kill).toHaveBeenCalledWith('p1', 9);
  });

  it('does not perform an operation when the retained pid no longer matches', async () => {
    const testHost = host({ ...running, pid: 456 });
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    await expect(capability.kill(15)).rejects.toMatchObject({
      code: 'STALE_PROCESS_HANDLE'
    });
    expect(testHost.control.kill).not.toHaveBeenCalled();
  });

  it('fails a stale capability before direct process contact', async () => {
    const testHost = host();
    testHost.lifecycle.runRead = async () => {
      throw new StaleProcessHandleError({
        code: 'STALE_PROCESS_HANDLE',
        message: 'stale',
        context: { processId: 'p1', pid: 123, operation: 'process.status' },
        httpStatus: 409,
        timestamp: new Date().toISOString()
      });
    };
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    await expect(capability.status()).rejects.toBeInstanceOf(
      StaleProcessHandleError
    );
    expect(testHost.control.getProcess).not.toHaveBeenCalled();
  });

  it('turns a runtime change after kill acknowledgement into interruption', async () => {
    const testHost = host();
    testHost.lifecycle.runControl = async (_runtime, _operation, call) => {
      await call(testHost.control);
      throw new OperationInterruptedError({
        code: 'OPERATION_INTERRUPTED',
        message: 'runtime changed',
        context: {
          reason: 'runtime_replaced',
          operation: 'process.kill',
          admitted: true,
          retryable: false,
          effect: 'unknown'
        },
        httpStatus: 409,
        timestamp: new Date().toISOString()
      });
    };
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    await expect(capability.kill(15)).rejects.toBeInstanceOf(
      OperationInterruptedError
    );
    expect(testHost.control.kill).toHaveBeenCalledOnce();
  });

  it('fences forwarded terminal events and releases capnweb ownership once', async () => {
    const testHost = host();
    const terminal: ProcessLogEvent = {
      type: 'terminal',
      state: 'exited',
      cursor: '1',
      timestamp: new Date().toISOString(),
      exit: { code: 0, timedOut: false }
    };
    const remote = subscription([terminal]);
    testHost.control.openLogs = vi.fn(async () => remote);
    const read = vi.spyOn(testHost.lifecycle, 'runRead');
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    const stream = await (await capability.openLogs()).stream();
    await expect(stream.getReader().read()).resolves.toEqual({
      done: false,
      value: terminal
    });

    expect(read.mock.calls.map((call) => call[1])).toEqual([
      'process.logs.open',
      'process.logs.forward',
      'process.logs.forward'
    ]);
    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it.each(['terminal', 'closure', 'read failure'])(
    'settles %s without awaiting remote cancellation',
    async (outcome) => {
      const testHost = host();
      const terminal: ProcessLogEvent = {
        type: 'terminal',
        state: 'exited',
        cursor: '1',
        timestamp: new Date().toISOString(),
        exit: { code: 0, timedOut: false }
      };
      const remote: ProcessLogSubscriptionAPI = {
        stream: vi.fn(
          async () =>
            new ReadableStream<ProcessLogEvent>({
              start(controller) {
                if (outcome === 'terminal') controller.enqueue(terminal);
                if (outcome === 'closure') controller.close();
                if (outcome === 'read failure')
                  controller.error(new Error('read failed'));
              }
            })
        ),
        cancel: vi.fn(() => new Promise<void>(() => undefined)),
        [Symbol.dispose]: vi.fn()
      };
      testHost.control.openLogs = vi.fn(async () => remote);
      const capability = new ProcessCapabilityTarget({
        id: 'p1',
        pid: 123,
        runtime: { id: 'runtime-a' },
        lifecycle: testHost.lifecycle
      });

      const read = (await (await capability.openLogs()).stream())
        .getReader()
        .read();
      if (outcome === 'terminal')
        await expect(read).resolves.toEqual({ done: false, value: terminal });
      else if (outcome === 'closure')
        await expect(read).resolves.toEqual({ done: true, value: undefined });
      else await expect(read).rejects.toBeInstanceOf(Error);
      expect(remote.cancel).toHaveBeenCalledOnce();
      expect(remote[Symbol.dispose]).toHaveBeenCalledOnce();
    }
  );

  it('exposes setup failure without awaiting remote cancellation', async () => {
    const testHost = host();
    const remote: ProcessLogSubscriptionAPI = {
      stream: vi.fn(async () => {
        throw new Error('setup failed');
      }),
      cancel: vi.fn(() => new Promise<void>(() => undefined)),
      [Symbol.dispose]: vi.fn()
    };
    testHost.control.openLogs = vi.fn(async () => remote);
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    await expect((await capability.openLogs()).stream()).rejects.toThrow(
      'setup failed'
    );
    expect(remote.cancel).toHaveBeenCalledOnce();
    expect(remote[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it('translates late capnweb stream failures at the SDK boundary', async () => {
    const testHost = host();
    const remote: ProcessLogSubscriptionAPI = {
      stream: vi.fn(
        async () =>
          new ReadableStream<ProcessLogEvent>({
            pull() {
              throw new Error('WebSocket connection failed.');
            }
          })
      ),
      cancel: vi.fn(async () => undefined),
      [Symbol.dispose]: vi.fn()
    };
    testHost.control.openLogs = vi.fn(async () => remote);
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    const stream = await (await capability.openLogs()).stream();

    await expect(stream.getReader().read()).rejects.toBeInstanceOf(
      RPCTransportError
    );
    expect(remote.cancel).toHaveBeenCalledTimes(1);
    expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it('uses read fencing for subscription admission', async () => {
    const testHost = host();
    const read = vi.spyOn(testHost.lifecycle, 'runRead');
    const capability = new ProcessCapabilityTarget({
      id: 'p1',
      pid: 123,
      runtime: { id: 'runtime-a' },
      lifecycle: testHost.lifecycle
    });

    await capability.openLogs({ replay: true, follow: true });
    await capability.openPortWatch(8080, { mode: 'tcp' });

    expect(read.mock.calls.map((call) => call[1])).toEqual([
      'process.logs.open',
      'process.port.open'
    ]);
  });
});
