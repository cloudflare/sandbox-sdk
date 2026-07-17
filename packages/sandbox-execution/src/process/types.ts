import type { ExecutionArgv } from '../command';

export interface RuntimeProcessExit {
  code: number;
  signal?: number;
  timedOut: boolean;
}

export interface RuntimeProcessFailure {
  code: string;
  message: string;
}

interface RuntimeProcessStatusBase {
  pid: number;
  command: ExecutionArgv;
  cwd?: string;
  startedAt: string;
}

export type RuntimeRunningProcess = RuntimeProcessStatusBase & {
  state: 'running';
};

export type RuntimeExitedProcess = RuntimeProcessStatusBase & {
  state: 'exited';
  exit: RuntimeProcessExit;
  endedAt: string;
};

export type RuntimeErroredProcess = RuntimeProcessStatusBase & {
  state: 'error';
  error: RuntimeProcessFailure;
  endedAt: string;
};

export type RuntimeProcessStatus =
  | RuntimeRunningProcess
  | RuntimeExitedProcess
  | RuntimeErroredProcess;

export type RuntimeProcessState = RuntimeProcessStatus['state'];

export type RuntimeProcessLogEvent =
  | {
      type: 'stdout' | 'stderr';
      state?: never;
      cursor: string;
      timestamp: string;
      data: Uint8Array;
    }
  | {
      type: 'terminal';
      state: 'exited';
      cursor: string;
      timestamp: string;
      exit: RuntimeProcessExit;
    }
  | {
      type: 'terminal';
      state: 'error';
      cursor: string;
      timestamp: string;
      error: RuntimeProcessFailure;
    }
  | {
      type: 'truncated';
      state?: never;
      cursor?: string;
      timestamp: string;
    };
