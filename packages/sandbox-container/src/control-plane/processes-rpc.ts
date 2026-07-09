import type {
  ProcessLogEvent,
  ProcessLogSubscriptionAPI,
  ProcessLogsRPCOptions,
  ProcessStartOptions,
  ProcessStatus,
  SandboxCommand,
  SandboxProcessesAPI
} from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type { ProcessService } from '../services/process-service';
import { StreamSubscriptionRPC } from './subscription-rpc';

type ProcessServiceAPI = Pick<
  ProcessService,
  'start' | 'get' | 'list' | 'openLogs' | 'kill' | 'hasActive'
>;

export class ProcessesRPCAPI extends RpcTarget implements SandboxProcessesAPI {
  readonly #service: ProcessServiceAPI;

  constructor(service: ProcessServiceAPI) {
    super();
    this.#service = service;
  }

  start(
    command: SandboxCommand,
    options?: ProcessStartOptions
  ): Promise<ProcessStatus> {
    return this.#service.start(command, options);
  }

  get(id: string): Promise<ProcessStatus | null> {
    return this.#service.get(id);
  }

  list(): Promise<ProcessStatus[]> {
    return this.#service.list();
  }

  async openLogs(
    id: string,
    options?: ProcessLogsRPCOptions
  ): Promise<ProcessLogSubscriptionAPI> {
    return new StreamSubscriptionRPC<ProcessLogEvent>(
      await this.#service.openLogs(id, options)
    );
  }

  kill(id: string, signal?: number): Promise<void> {
    return this.#service.kill(id, signal);
  }

  hasActive(): Promise<boolean> {
    return this.#service.hasActive();
  }
}
