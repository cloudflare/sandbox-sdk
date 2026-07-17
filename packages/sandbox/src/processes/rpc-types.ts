import type {
  PortWatchEvent,
  PortWatchRPCOptions,
  ProcessLogEvent,
  ProcessLogsRPCOptions,
  ProcessStatus
} from '@repo/shared';

export interface ProcessSubscriptionRPC<T> {
  stream(): Promise<ReadableStream<T>>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}

export type ProcessLogSubscriptionRPC = ProcessSubscriptionRPC<ProcessLogEvent>;

export type ProcessPortSubscriptionRPC = ProcessSubscriptionRPC<PortWatchEvent>;

export interface ProcessCapabilityRPC {
  status(): Promise<ProcessStatus>;
  openLogs(options?: ProcessLogsRPCOptions): Promise<ProcessLogSubscriptionRPC>;
  openPortWatch(
    port: number,
    options?: PortWatchRPCOptions
  ): Promise<ProcessPortSubscriptionRPC>;
  kill(signal: number): Promise<void>;
}

export interface ProcessRPCDescriptor {
  id: string;
  pid: number;
  capability: ProcessCapabilityRPC;
}
