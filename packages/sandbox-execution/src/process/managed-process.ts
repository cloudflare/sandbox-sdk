import type { ProcessLogSubscriptionOptions } from './process-log-store';
import type {
  RuntimeProcessExit,
  RuntimeProcessFailure,
  RuntimeProcessLogEvent,
  RuntimeProcessStatus
} from './types';

export type {
  RuntimeProcessExit,
  RuntimeProcessFailure,
  RuntimeProcessStatus
} from './types';

export interface RuntimeManagedProcess {
  readonly pid: number;
  snapshot(): RuntimeProcessStatus;
  logs(
    options?: ProcessLogSubscriptionOptions
  ): ReadableStream<RuntimeProcessLogEvent>;
  waitForExit(): Promise<RuntimeProcessStatus>;
  kill(signal?: number): Promise<void>;
}
