import type { ContainerControlClient } from '../container-control/client';
import type {
  CurrentRuntimeIdentity,
  RuntimeIdentity
} from '../current-runtime-identity';
import {
  ErrorCode,
  type OperationInterruptedContext,
  OperationInterruptedError,
  StaleProcessHandleError
} from '../errors';
import type { ResourceActivityOperation } from '../resource-activity-gate';

export type ProcessLifecycleRuntimeClient = {
  get(runtimeIdentityID: RuntimeIdentity['id']): ContainerControlClient;
  dispose(): void;
};

type ProcessLifecycleOptions = {
  currentRuntime: Pick<CurrentRuntimeIdentity, 'get' | 'assertActive'>;
  runtimeClient: ProcessLifecycleRuntimeClient;
  beginNonWakingOperation: () => ResourceActivityOperation;
  process?: { id: string; pid: number };
};

type OperationEffect = 'none' | 'unknown';

/** Applies non-starting admission and runtime fences around process RPCs. */
export class ProcessLifecycle {
  constructor(private readonly options: ProcessLifecycleOptions) {}

  captureCurrent(): Promise<RuntimeIdentity | null> {
    return this.options.currentRuntime.get();
  }

  runRead<T>(
    runtime: RuntimeIdentity,
    operation: string,
    fn: (client: ContainerControlClient) => Promise<T>
  ): Promise<T> {
    return this.run(runtime, operation, 'none', fn);
  }

  runControl<T>(
    runtime: RuntimeIdentity,
    operation: string,
    fn: (client: ContainerControlClient) => Promise<T>
  ): Promise<T> {
    return this.run(runtime, operation, 'unknown', fn);
  }

  private async run<T>(
    runtime: RuntimeIdentity,
    operation: string,
    effect: OperationEffect,
    fn: (client: ContainerControlClient) => Promise<T>
  ): Promise<T> {
    const admission = this.options.beginNonWakingOperation();
    try {
      await admission.beforeCall;
      await this.assertPreFence(runtime, operation, effect);
      try {
        const client = this.options.runtimeClient.get(runtime.id);
        const result = await fn(client);
        await this.assertPostFence(runtime, operation, effect);
        return result;
      } catch (error) {
        try {
          await this.options.currentRuntime.assertActive(runtime);
        } catch {
          this.options.runtimeClient.dispose();
          throw interrupted(operation, effect);
        }
        throw error;
      }
    } finally {
      admission.finish();
    }
  }

  private async assertPreFence(
    runtime: RuntimeIdentity,
    operation: string,
    effect: OperationEffect
  ): Promise<void> {
    try {
      await this.options.currentRuntime.assertActive(runtime);
    } catch {
      this.options.runtimeClient.dispose();
      const process = this.options.process;
      if (process) {
        throw new StaleProcessHandleError({
          code: ErrorCode.STALE_PROCESS_HANDLE,
          message: `Process handle ${process.id} belongs to an inactive runtime`,
          context: {
            processId: process.id,
            pid: process.pid,
            operation
          },
          httpStatus: 409,
          timestamp: new Date().toISOString()
        });
      }
      throw interrupted(operation, effect);
    }
  }

  private async assertPostFence(
    runtime: RuntimeIdentity,
    operation: string,
    effect: OperationEffect
  ): Promise<void> {
    try {
      await this.options.currentRuntime.assertActive(runtime);
    } catch {
      this.options.runtimeClient.dispose();
      throw interrupted(operation, effect);
    }
  }
}

function interrupted(
  operation: string,
  effect: OperationEffect
): OperationInterruptedError {
  const context: OperationInterruptedContext = {
    reason: 'runtime_replaced',
    operation,
    admitted: true,
    retryable: false,
    effect
  };
  return new OperationInterruptedError({
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: `Sandbox operation ${operation} was interrupted because the runtime changed`,
    context,
    httpStatus: 409,
    timestamp: new Date().toISOString()
  });
}
