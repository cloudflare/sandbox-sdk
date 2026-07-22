import { DurableObject, RpcTarget } from 'cloudflare:workers';
import type {
  PortWatchRPCOptions,
  PortWatchSubscriptionAPI,
  ProcessLogEvent,
  ProcessLogSubscriptionAPI,
  ProcessLogsRPCOptions,
  ProcessStatus
} from '@repo/shared';
import {
  type ProcessCapabilityControl,
  type ProcessCapabilityLifecycle,
  ProcessCapabilityTarget
} from '../../src/processes/process-capability';
import type { ProcessRPCDescriptor } from '../../src/processes/rpc-types';

const status: ProcessStatus = {
  id: 'p1',
  pid: 123,
  command: ['/bin/true'],
  state: 'running',
  startedAt: '2026-07-08T00:00:00.000Z'
};

class CleanLogSubscription
  extends RpcTarget
  implements ProcessLogSubscriptionAPI
{
  stream(): Promise<ReadableStream<ProcessLogEvent>> {
    return Promise.resolve(
      new ReadableStream<ProcessLogEvent>({
        start(controller) {
          controller.close();
        }
      })
    );
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.dispose](): void {}
}

class CapabilityControl implements ProcessCapabilityControl {
  retainRuntimeHold(): () => void {
    return () => undefined;
  }

  getProcess(): Promise<ProcessStatus> {
    return Promise.resolve(status);
  }

  openLogs(
    _id: string,
    _options?: ProcessLogsRPCOptions
  ): Promise<ProcessLogSubscriptionAPI> {
    return Promise.resolve(new CleanLogSubscription());
  }

  openPortWatch(
    _port: number,
    _options?: PortWatchRPCOptions
  ): Promise<PortWatchSubscriptionAPI> {
    throw new Error('not used');
  }

  kill(): Promise<void> {
    return Promise.resolve();
  }
}

class CapabilityLifecycle implements ProcessCapabilityLifecycle {
  readonly #control = new CapabilityControl();

  runRead<T>(
    _runtime: { readonly id: string },
    _operation: string,
    call: (control: ProcessCapabilityControl) => Promise<T>
  ): Promise<T> {
    return call(this.#control);
  }

  runControl<T>(
    _runtime: { readonly id: string },
    _operation: string,
    call: (control: ProcessCapabilityControl) => Promise<T>
  ): Promise<T> {
    return call(this.#control);
  }
}

export class ProcessCapabilityRPCTestDO extends DurableObject {
  accept(_value: object): Promise<boolean> {
    return Promise.resolve(true);
  }

  descriptor(): Promise<ProcessRPCDescriptor> {
    return Promise.resolve({
      id: status.id,
      pid: status.pid,
      capability: new ProcessCapabilityTarget({
        id: status.id,
        pid: status.pid,
        runtime: {
          id: 'runtime-test',
          runtimeIncarnationID: 'incarnation-test'
        },
        lifecycle: new CapabilityLifecycle()
      })
    });
  }
}
