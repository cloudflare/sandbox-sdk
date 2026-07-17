export type SandboxCommand = readonly [executable: string, ...args: string[]];

/**
 * Terminal outcome observed for the root subprocess.
 *
 * The process resource remains running until its supervised process group has
 * settled. Signals delivered only to descendants do not rewrite this outcome.
 */
export interface ProcessExit {
  code: number;
  signal?: number;
  timedOut: boolean;
}

export interface ProcessFailure {
  code: string;
  message: string;
}

interface ProcessStatusBase {
  id: string;
  pid: number;
  command: SandboxCommand;
  cwd?: string;
  startedAt: string;
}

/** Lifecycle state for the complete supervised process group. */
export type ProcessStatus =
  | (ProcessStatusBase & { state: 'running' })
  | (ProcessStatusBase & {
      state: 'exited';
      exit: ProcessExit;
      endedAt: string;
    })
  | (ProcessStatusBase & {
      state: 'error';
      error: ProcessFailure;
      endedAt: string;
    });

export type ProcessLogCursor = string;

export type ProcessLogEvent =
  | {
      type: 'stdout' | 'stderr';
      cursor: ProcessLogCursor;
      timestamp: string;
      data: Uint8Array;
    }
  | {
      type: 'terminal';
      state: 'exited';
      cursor: ProcessLogCursor;
      timestamp: string;
      exit: ProcessExit;
    }
  | {
      type: 'terminal';
      state: 'error';
      cursor: ProcessLogCursor;
      timestamp: string;
      error: ProcessFailure;
    }
  | {
      type: 'truncated';
      cursor?: ProcessLogCursor;
      timestamp: string;
    };

export interface WaitForLogResult {
  stream: 'stdout' | 'stderr';
  text: string;
  match: string;
  cursor?: ProcessLogCursor;
}

export interface ProcessStartOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ProcessLogsRPCOptions {
  since?: ProcessLogCursor;
  replay?: boolean;
  follow?: boolean;
}

export interface ProcessLogSubscriptionAPI {
  stream(): Promise<ReadableStream<ProcessLogEvent>>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}

export interface SandboxProcessesAPI {
  start(
    command: SandboxCommand,
    options?: ProcessStartOptions
  ): Promise<ProcessStatus>;
  get(id: string): Promise<ProcessStatus | null>;
  list(): Promise<ProcessStatus[]>;
  openLogs(
    id: string,
    options?: ProcessLogsRPCOptions
  ): Promise<ProcessLogSubscriptionAPI>;
  kill(id: string, signal?: number): Promise<void>;
  hasActive(): Promise<boolean>;
}
