import { describe, expect, it, vi } from 'vitest';
import type { ContainerControlClient } from '../../src/container-control/client';
import {
  CurrentRuntimeIdentity,
  RuntimeIdentity,
  type RuntimeIdentityID
} from '../../src/current-runtime-identity';
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError,
  StaleProcessHandleError
} from '../../src/errors';
import { ProcessLifecycle } from '../../src/processes/process-lifecycle';
import type { ResourceActivityOperation } from '../../src/resource-activity-gate';

function runtime(id: string): RuntimeIdentity {
  return new RuntimeIdentity({ id: id as RuntimeIdentityID });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function operation(): ResourceActivityOperation {
  return { beforeCall: Promise.resolve(), finish: vi.fn() };
}

function createStorage(initial = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      initial.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      initial.delete(key);
    })
  } as unknown as DurableObjectState['storage'];
}

function createLifecycle(options: {
  current?: RuntimeIdentity | null;
  client?: ContainerControlClient;
  process?: { id: string; pid: number };
  acquisitionError?: Error;
}) {
  let current = options.current ?? null;
  const currentRuntime = {
    get: vi.fn(async () => current),
    assertActive: vi.fn(async (expected: RuntimeIdentity) => {
      if (current?.id !== expected.id) {
        throw new Error('inactive');
      }
    })
  } as Pick<CurrentRuntimeIdentity, 'get' | 'assertActive'>;
  const directClient = options.client ?? ({} as ContainerControlClient);
  const runtimeClient = {
    get: vi.fn(() => {
      if (options.acquisitionError) throw options.acquisitionError;
      return directClient;
    }),
    dispose: vi.fn()
  };
  const admission = operation();
  const lifecycle = new ProcessLifecycle({
    currentRuntime,
    runtimeClient,
    beginNonWakingOperation: () => admission,
    process: options.process
  });
  return {
    lifecycle,
    currentRuntime,
    runtimeClient,
    admission,
    setCurrent(value: RuntimeIdentity | null) {
      current = value;
    }
  };
}

describe('ProcessLifecycle', () => {
  it('captures inactive runtime absence without creating a direct client', async () => {
    const host = createLifecycle({ current: null });

    await expect(host.lifecycle.captureCurrent()).resolves.toBeNull();

    expect(host.runtimeClient.get).not.toHaveBeenCalled();
  });

  it('captures the current runtime after a failed identity clear', async () => {
    const storage = createStorage(
      new Map([['currentRuntimeIdentity', { id: 'runtime-1' }]])
    );
    const currentRuntime = new CurrentRuntimeIdentity(
      storage,
      async () => ({ status: 'healthy' }),
      () => true
    );
    const runtimeClient = {
      get: vi.fn(),
      dispose: vi.fn()
    };
    const lifecycle = new ProcessLifecycle({
      currentRuntime,
      runtimeClient,
      beginNonWakingOperation: operation
    });
    const error = new Error('delete failed');
    vi.mocked(storage.delete).mockRejectedValueOnce(error);

    await expect(currentRuntime.clear()).rejects.toBe(error);

    await expect(lifecycle.captureCurrent()).resolves.toMatchObject({
      id: 'runtime-1'
    });
    expect(runtimeClient.get).not.toHaveBeenCalled();
  });

  it('rejects a stale handle before direct contact', async () => {
    const expected = runtime('runtime-a');
    const direct = vi.fn();
    const host = createLifecycle({
      current: runtime('runtime-b'),
      process: { id: 'process-1', pid: 42 }
    });

    await expect(
      host.lifecycle.runRead(expected, 'process.status', async () => direct())
    ).rejects.toBeInstanceOf(StaleProcessHandleError);

    expect(direct).not.toHaveBeenCalled();
    expect(host.runtimeClient.get).not.toHaveBeenCalled();
    expect(host.admission.finish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['process.get', 'read', 'none'] as const,
    ['process.list', 'read', 'none'] as const,
    ['process.status', 'read', 'none'] as const,
    ['process.kill', 'control', 'unknown'] as const
  ])(
    'post-fences an in-flight %s operation',
    async (operationName, kind, effect) => {
      const expected = runtime('runtime-a');
      const pending = deferred<string>();
      const host = createLifecycle({
        current: expected,
        process: { id: 'process-1', pid: 42 }
      });
      const call =
        kind === 'read'
          ? host.lifecycle.runRead(
              expected,
              operationName,
              () => pending.promise
            )
          : host.lifecycle.runControl(
              expected,
              operationName,
              () => pending.promise
            );

      await vi.waitFor(() => expect(host.runtimeClient.get).toHaveBeenCalled());
      host.setCurrent(runtime('runtime-b'));
      pending.resolve('ack');

      const error = await call.catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(OperationInterruptedError);
      expect((error as OperationInterruptedError).context).toMatchObject({
        operation: operationName,
        effect,
        admitted: true
      });
      expect(
        (error as OperationInterruptedError).context.phase
      ).toBeUndefined();
      expect(host.admission.finish).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves a typed expected-live client acquisition failure', async () => {
    const expected = runtime('runtime-a');
    const transport = new RPCTransportError({
      code: ErrorCode.RPC_TRANSPORT_ERROR,
      message: 'direct port unavailable',
      context: {
        kind: 'connection_failed',
        originalMessage: 'direct port unavailable',
        errorName: 'Error'
      },
      httpStatus: 503,
      timestamp: new Date().toISOString()
    });
    const host = createLifecycle({
      current: expected,
      acquisitionError: transport
    });

    await expect(
      host.lifecycle.runRead(expected, 'process.list', async () => [])
    ).rejects.toBe(transport);
    expect(host.currentRuntime.assertActive).toHaveBeenCalledTimes(2);
    expect(host.admission.finish).toHaveBeenCalledTimes(1);
  });

  it('preserves an expected-live transport failure after a successful post-fence', async () => {
    const expected = runtime('runtime-a');
    const transport = new RPCTransportError({
      code: ErrorCode.RPC_TRANSPORT_ERROR,
      message: 'direct transport failed',
      context: {
        kind: 'connection_failed',
        originalMessage: 'direct transport failed',
        errorName: 'Error'
      },
      httpStatus: 503,
      timestamp: new Date().toISOString()
    });
    const host = createLifecycle({ current: expected });

    await expect(
      host.lifecycle.runRead(expected, 'process.list', async () => {
        throw transport;
      })
    ).rejects.toBe(transport);

    expect(host.admission.finish).toHaveBeenCalledTimes(1);
  });
});
