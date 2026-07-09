import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeIdentity,
  type RuntimeIdentityID
} from '../../src/current-runtime-identity';
import { OperationInterruptedError, RPCTransportError } from '../../src/errors';
import { ProcessLifecycle } from '../../src/processes/process-lifecycle';
import type { ResourceActivityOperation } from '../../src/resource-activity-gate';

let listProcesses: () => Promise<unknown>;

vi.mock('../../src/container-control/connection', () => ({
  ContainerControlConnection: class {
    isConnected() {
      return false;
    }
    getStats() {
      return { imports: 1, exports: 1 };
    }
    disconnect() {}
    rpc() {
      return {
        processes: {
          list: () => listProcesses()
        }
      };
    }
  }
}));

import { RuntimeControlClient } from '../../src/container-control/runtime-client';

function runtime(id: string): RuntimeIdentity {
  return new RuntimeIdentity({ id: id as RuntimeIdentityID });
}

function operation(): ResourceActivityOperation {
  return { beforeCall: Promise.resolve(), finish: vi.fn() };
}

function deferred<T>() {
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

function createHost(initial: RuntimeIdentity) {
  let current = initial;
  const runtimeClient = new RuntimeControlClient({
    getTcpPort: () => ({ fetch: vi.fn() }),
    beginNonWakingOperation: operation
  });
  const lifecycle = new ProcessLifecycle({
    currentRuntime: {
      get: async () => current,
      assertActive: async (expected: RuntimeIdentity) => {
        if (current.id !== expected.id) throw new Error('inactive');
      }
    },
    runtimeClient,
    beginNonWakingOperation: operation
  });
  return {
    lifecycle,
    replaceRuntime(next: RuntimeIdentity) {
      current = next;
    }
  };
}

describe('ProcessLifecycle direct transport errors', () => {
  beforeEach(() => {
    listProcesses = async () => [];
  });

  it('surfaces a typed transport error while the runtime remains active', async () => {
    const expected = runtime('runtime-a');
    const host = createHost(expected);
    listProcesses = async () => {
      throw new Error('WebSocket connection failed.');
    };

    const error = await host.lifecycle
      .runRead(expected, 'process.list', (client) => client.processes.list())
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(RPCTransportError);
    expect(error).not.toBeInstanceOf(OperationInterruptedError);
    expect((error as RPCTransportError).kind).toBe('connection_failed');
    expect((error as RPCTransportError).context).not.toHaveProperty('phase');
  });

  it('reclassifies the same transport failure after runtime replacement', async () => {
    const expected = runtime('runtime-a');
    const host = createHost(expected);
    const pending = deferred<unknown>();
    listProcesses = vi.fn(() => pending.promise);

    const call = host.lifecycle.runRead(expected, 'process.list', (client) =>
      client.processes.list()
    );
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled());

    host.replaceRuntime(runtime('runtime-b'));
    pending.reject(new Error('WebSocket connection failed.'));

    const error = await call.catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(OperationInterruptedError);
    expect((error as OperationInterruptedError).context).toMatchObject({
      reason: 'runtime_replaced',
      operation: 'process.list',
      admitted: true,
      retryable: false,
      effect: 'none'
    });
    expect((error as OperationInterruptedError).context).not.toHaveProperty(
      'phase'
    );
  });
});
