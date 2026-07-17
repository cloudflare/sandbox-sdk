import { RpcTarget } from 'cloudflare:workers';
import type {
  PortWatchRPCOptions,
  PortWatchSubscriptionAPI,
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
  ProcessSubscriptionRPC
} from './rpc-types';

export interface ProcessCapabilityRuntime {
  readonly id: string;
}

export interface ProcessCapabilityControl {
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
  ): Promise<ProcessLogSubscriptionRPC> {
    const subscription = await this.#lifecycle.runRead(
      this.#runtime,
      'process.logs.open',
      async (control) => {
        this.#verifiedStatus(await control.getProcess(this.#id));
        return control.openLogs(this.#id, options);
      }
    );
    return new FencedSubscriptionTarget({
      subscription,
      runtime: this.#runtime,
      lifecycle: this.#lifecycle,
      operation: 'process.logs.forward',
      isTerminal: (event) => event.type === 'terminal',
      allowCleanClose: true
    });
  }

  async openPortWatch(
    port: number,
    options?: PortWatchRPCOptions
  ): Promise<ProcessPortSubscriptionRPC> {
    const subscription = await this.#lifecycle.runRead(
      this.#runtime,
      'process.port.open',
      async (control) => {
        this.#verifiedStatus(await control.getProcess(this.#id));
        return control.openPortWatch(port, options);
      }
    );
    return new FencedSubscriptionTarget({
      subscription,
      runtime: this.#runtime,
      lifecycle: this.#lifecycle,
      operation: 'process.port.forward',
      isTerminal: (event) => event.type === 'ready' || event.type === 'error'
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
};

class FencedSubscriptionTarget<T>
  extends RpcTarget
  implements ProcessSubscriptionRPC<T>
{
  readonly #subscription: ProcessSubscriptionRPC<T>;
  readonly #runtime: ProcessCapabilityRuntime;
  readonly #lifecycle: ProcessCapabilityLifecycle;
  readonly #operation: string;
  readonly #isTerminal: (event: T) => boolean;
  readonly #allowCleanClose: boolean;
  #opened = false;
  #released = false;

  constructor(options: FencedSubscriptionOptions<T>) {
    super();
    this.#subscription = options.subscription;
    this.#runtime = options.runtime;
    this.#lifecycle = options.lifecycle;
    this.#operation = options.operation;
    this.#isTerminal = options.isTerminal;
    this.#allowCleanClose = options.allowCleanClose ?? false;
  }

  async stream(): Promise<ReadableStream<T>> {
    if (this.#opened) throw new Error('Subscription stream already opened');
    this.#opened = true;

    let source: ReadableStream<T>;
    try {
      source = await this.#lifecycle.runRead(
        this.#runtime,
        this.#operation,
        () => this.#subscription.stream()
      );
    } catch (error) {
      this.#release();
      throw error;
    }
    let reader: ReadableStreamDefaultReader<T>;
    try {
      reader = source.getReader();
    } catch (error) {
      this.#release();
      throw error;
    }

    return new ReadableStream<T>({
      pull: async (controller) => {
        let result: ReadableStreamReadResult<T>;
        try {
          result = await this.#lifecycle.runRead(
            this.#runtime,
            this.#operation,
            () => reader.read()
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
          if (this.#allowCleanClose) {
            controller.close();
            return;
          }
          translateRPCError(
            new Error('Process subscription closed before a terminal event'),
            {
              operation: this.#operation,
              translateTransportErrorsAsInterruptions: false
            }
          );
        }

        controller.enqueue(result.value);
        if (this.#isTerminal(result.value)) {
          this.#release();
          controller.close();
        }
      },
      cancel: () => {
        this.#release();
      }
    });
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
