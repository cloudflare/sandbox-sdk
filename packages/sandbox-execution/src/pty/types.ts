import type { ExecutionArgv } from '../command';
import type { ExecutionLogger } from '../logger';
import type {
  RuntimeProcessExit,
  RuntimeProcessFailure
} from '../process/managed-process';
import type { ProcessLogSubscriptionOptions } from '../process/process-log-store';

export interface PtyProcessOptions {
  command: ExecutionArgv;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  bufferSize?: number;
  logger?: ExecutionLogger;
}

export type RuntimeTerminalSnapshot =
  | { pid: number; state: 'running' }
  | { pid: number; state: 'exited'; exit: RuntimeProcessExit }
  | { pid: number; state: 'error'; error: RuntimeProcessFailure };

export type RuntimeTerminalResult =
  | { state: 'exited'; exit: RuntimeProcessExit }
  | { state: 'error'; error: RuntimeProcessFailure };

export type RuntimeTerminalOutputEvent =
  | { type: 'data'; cursor: string; timestamp: string; data: Uint8Array }
  | ({
      type: 'terminal';
      cursor: string;
      timestamp: string;
    } & RuntimeTerminalResult)
  | { type: 'truncated'; cursor?: string; timestamp: string };

export interface RuntimeTerminalProcess {
  /**
   * PTY completion requires both the root subprocess outcome and PTY EOF.
   * Descendants that retain the PTY keep the terminal active until they exit
   * or the terminal is explicitly closed.
   */
  snapshot(): RuntimeTerminalSnapshot;
  output(
    options?: ProcessLogSubscriptionOptions
  ): ReadableStream<RuntimeTerminalOutputEvent>;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): void;
  waitForExit(): Promise<RuntimeTerminalResult>;
  interrupt(): Promise<void>;
  terminate(): Promise<void>;
  close(): Promise<void>;
}
