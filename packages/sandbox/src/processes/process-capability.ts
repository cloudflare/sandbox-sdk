import { RpcTarget } from 'cloudflare:workers';
import type {
  PortWatchEvent,
  PortWatchRPCOptions,
  PortWatchSubscriptionAPI,
  ProcessLogEvent,
  ProcessLogSubscriptionAPI,
  ProcessLogsRPCOptions,
  ProcessStatus
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { translateRPCError } from '../container-control/rpc-error';
import { ProcessNotFoundError, StaleProcessHandleError } from '../errors';
import type {
  ProcessLogSubscriptionRPC,
  ProcessPortSubscriptionRPC,
  ProcessPullSubscriptionRPC,
  ProcessSubscriptionRPC
} from './rpc-types';

export interface ProcessCapabilityRuntime {
  readonly id: string;
  readonly runtimeIncarnationID: string;
}

export interface ProcessCapabilityControl {
  retainRuntimeHold(): () => void;
  getProcess(id: string): Promise<ProcessStatus | null>;
  openLogs(
    id: string,
    options?: ProcessLogsRPCOptions
  ): Promise<ProcessLogSubscriptionAPI>;
  openPortWatch(
    port: number,
    options?: PortWatchRPCOptions
  ): Promise<PortWatchSubscriptionAPI>;
  kill(id: string, signal: number): Promise<void>;
}

export interface ProcessCapabilityLifecycle {
  runRead<T>(
    runtime: ProcessCapabilityRuntime,
    operation: string,
    call: (control: ProcessCapabilityControl) => Promise<T>
  ): Promise<T>;
  runControl<T>(
    runtime: ProcessCapabilityRuntime,
    operation: string,
    call: (control: ProcessCapabilityControl) => Promise<T>
  ): Promise<T>;
}

type ProcessCapabilityTargetOptions = {
  id: string;
  pid: number;
  runtime: ProcessCapabilityRuntime;
  lifecycle: ProcessCapabilityLifecycle;
};

export class ProcessCapabilityTarget extends RpcTarget {
  readonly #id: string;
  readonly #pid: number;
  readonly #runtime: ProcessCapabilityRuntime;
  readonly #lifecycle: ProcessCapabilityLifecycle;

  constructor(options: ProcessCapabilityTargetOptions) {
    super();
    this.#id = options.id;
    this.#pid = options.pid;
    this.#runtime = options.runtime;
    this.#lifecycle = options.lifecycle;
  }

  status(): Promise<ProcessStatus> {
    return this.#lifecycle.runRead(
      this.#runtime,
      'process.status',
      async (control) =>
        this.#verifiedStatus(await control.getProcess(this.#id))
    );
  }

  async openLogs(
    options?: ProcessLogsRPCOptions
  ): Promise<ProcessPullSubscriptionRPC<ProcessLogEvent>> {
    const retained = await this.#lifecycle.runRead(
      this.#runtime,
      'process.logs.open',
      async (control) => {
        const releaseConnection = control.retainRuntimeHold();
        try {
          this.#verifiedStatus(await control.getProcess(this.#id));
          return {
            subscription: await control.openLogs(this.#id, options),
            releaseConnection
          };
        } catch (error) {
          releaseConnection();
          throw error;
        }
      }
    );
    return new FencedSubscriptionTarget({
      subscription: retained.subscription,
      runtime: this.#runtime,
      lifecycle: this.#lifecycle,
      operation: 'process.logs.forward',
      isTerminal: (event) => event.type === 'terminal',
      allowCleanClose: true,
      releaseConnection: retained.releaseConnection
    });
  }

  async openPortWatch(
    port: number,
    options?: PortWatchRPCOptions
  ): Promise<ProcessPullSubscriptionRPC<PortWatchEvent>> {
    const retained = await this.#lifecycle.runRead(
      this.#runtime,
      'process.port.open',
      async (control) => {
        const releaseConnection = control.retainRuntimeHold();
        try {
          this.#verifiedStatus(await control.getProcess(this.#id));
          return {
            subscription: await control.openPortWatch(port, options),
            releaseConnection
          };
        } catch (error) {
          releaseConnection();
          throw error;
        }
      }
    );
    return new FencedSubscriptionTarget({
      subscription: retained.subscription,
      runtime: this.#runtime,
      lifecycle: this.#lifecycle,
      operation: 'process.port.forward',
      isTerminal: (event) => event.type === 'ready' || event.type === 'error',
      releaseConnection: retained.releaseConnection
    });
  }

  kill(signal: number): Promise<void> {
    return this.#lifecycle.runControl(
      this.#runtime,
      'process.kill',
      async (control) => {
        this.#verifiedStatus(await control.getProcess(this.#id));
        await control.kill(this.#id, signal);
      }
    );
  }

  #verifiedStatus(status: ProcessStatus | null): ProcessStatus {
    if (!status) {
      throw new ProcessNotFoundError({
        code: ErrorCode.PROCESS_NOT_FOUND,
        message: `Process not found: ${this.#id}`,
        context: { processId: this.#id },
        httpStatus: 404,
        timestamp: new Date().toISOString()
      });
    }
    if (status.id !== this.#id || status.pid !== this.#pid) {
      throw staleHandle(this.#id, this.#pid, 'process identity');
    }
    return status;
  }
}

type FencedSubscriptionOptions<T> = {
  subscription: ProcessSubscriptionRPC<T>;
  runtime: ProcessCapabilityRuntime;
  lifecycle: ProcessCapabilityLifecycle;
  operation: string;
  isTerminal: (event: T) => boolean;
  allowCleanClose?: boolean;
  releaseConnection?: () => void;
};

class FencedSubscriptionTarget<T>
  extends RpcTarget
  implements ProcessPullSubscriptionRPC<T>
{
  readonly #subscription: ProcessSubscriptionRPC<T>;
  readonly #runtime: ProcessCapabilityRuntime;
  readonly #lifecycle: ProcessCapabilityLifecycle;
  readonly #operation: string;
  readonly #isTerminal: (event: T) => boolean;
  readonly #allowCleanClose: boolean;
  readonly #releaseConnection: (() => void) | undefined;
  #reader: ReadableStreamDefaultReader<T> | undefined;
  #released = false;

  constructor(options: FencedSubscriptionOptions<T>) {
    super();
    this.#subscription = options.subscription;
    this.#runtime = options.runtime;
    this.#lifecycle = options.lifecycle;
    this.#operation = options.operation;
    this.#isTerminal = options.isTerminal;
    this.#allowCleanClose = options.allowCleanClose ?? false;
    this.#releaseConnection = options.releaseConnection;
  }

  async next(): Promise<ReadableStreamReadResult<T>> {
    if (this.#released) return { done: true, value: undefined };

    if (!this.#reader) {
      try {
        const source = await this.#lifecycle.runRead(
          this.#runtime,
          this.#operation,
          () => this.#subscription.stream()
        );
        this.#reader = source.getReader();
      } catch (error) {
        this.#release();
        throw error;
      }
    }

    let result: ReadableStreamReadResult<T>;
    try {
      result = await this.#lifecycle.runRead(
        this.#runtime,
        this.#operation,
        () => this.#reader!.read()
      );
    } catch (error) {
      this.#release();
      translateRPCError(error, {
        operation: this.#operation,
        translateTransportErrorsAsInterruptions: false
      });
    }

    if (result.done) {
      this.#release();
      if (this.#allowCleanClose) return result;
      translateRPCError(
        new Error('Process subscription closed before a terminal event'),
        {
          operation: this.#operation,
          translateTransportErrorsAsInterruptions: false
        }
      );
    }

    if (this.#isTerminal(result.value)) this.#release();
    return result;
  }

  async cancel(): Promise<void> {
    this.#release();
  }

  [Symbol.dispose](): void {
    void this.#release();
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#releaseConnection?.();
    try {
      void this.#reader?.cancel().catch(() => undefined);
    } catch {
      // Remote subscription cleanup below remains authoritative.
    }
    try {
      void this.#subscription.cancel().catch(() => undefined);
    } catch {
      // Local disposal still runs after a synchronous RPC failure.
    }
    try {
      this.#subscription[Symbol.dispose]();
    } catch {
      // Caller-visible stream settlement remains authoritative.
    }
  }
}

function staleHandle(
  processId: string,
  pid: number,
  operation: string
): StaleProcessHandleError {
  return new StaleProcessHandleError({
    code: ErrorCode.STALE_PROCESS_HANDLE,
    message: `Process handle ${processId} no longer identifies PID ${pid}`,
    context: { processId, pid, operation },
    httpStatus: 409,
    timestamp: new Date().toISOString()
  });
}
