import type {
  ProcessExit,
  ProcessFailure,
  SandboxCommand
} from './process-types.js';
import type { WaitForExitOptions } from './types/core.js';

export interface CreateTerminalOptions {
  command: SandboxCommand;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  bufferSize?: number;
}

export interface TerminalSnapshot {
  id: string;
  pid?: number;
  command: SandboxCommand;
  cwd?: string;
  status: 'running' | 'exited' | 'error';
  exit?: ProcessExit;
  error?: ProcessFailure;
}

export type TerminalOutputCursor = string;

export interface TerminalOutputOptions {
  since?: TerminalOutputCursor;
  replay?: boolean;
  follow?: boolean;
  signal?: AbortSignal;
}

export type TerminalOutputEvent =
  | {
      type: 'data';
      terminalId: string;
      cursor: TerminalOutputCursor;
      timestamp: string;
      data: Uint8Array;
    }
  | {
      type: 'terminal';
      terminalId: string;
      cursor: TerminalOutputCursor;
      timestamp: string;
      state: 'exited';
      exit: ProcessExit;
    }
  | {
      type: 'terminal';
      terminalId: string;
      cursor: TerminalOutputCursor;
      timestamp: string;
      state: 'error';
      error: ProcessFailure;
    }
  | {
      type: 'truncated';
      terminalId: string;
      cursor?: TerminalOutputCursor;
      timestamp: string;
    };

export interface TerminalOutputSubscriptionAPI {
  stream(): Promise<ReadableStream<TerminalOutputEvent>>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}

export interface Terminal {
  readonly id: string;
  getSnapshot(): Promise<TerminalSnapshot>;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  output(
    options?: TerminalOutputOptions
  ): Promise<ReadableStream<TerminalOutputEvent>>;
  waitForExit(options?: WaitForExitOptions): Promise<ProcessExit>;
  interrupt(): Promise<void>;
  terminate(): Promise<void>;
  connect(
    request: Request,
    options?: { cursor?: TerminalOutputCursor; cols?: number; rows?: number }
  ): Promise<Response>;
}

export interface SandboxTerminalsAPI {
  create(options: CreateTerminalOptions): Promise<TerminalSnapshot>;
  get(id: string): Promise<TerminalSnapshot | null>;
  list(): Promise<TerminalSnapshot[]>;
  output(
    id: string,
    options?: Omit<TerminalOutputOptions, 'signal'>
  ): Promise<TerminalOutputSubscriptionAPI>;
  write(id: string, data: Uint8Array): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  interrupt(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  hasActive(): Promise<boolean>;
}

export type PtyClientControlMessage =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'interrupt' }
  | { type: 'terminate' };

export type PtyServerControlMessage =
  | { type: 'ready'; cursor?: TerminalOutputCursor }
  | { type: 'chunk'; cursor: TerminalOutputCursor; byteLength: number }
  | { type: 'truncated'; cursor?: TerminalOutputCursor }
  | { type: 'exit'; cursor: TerminalOutputCursor; exit: ProcessExit }
  | {
      type: 'error';
      cursor?: TerminalOutputCursor;
      code?: string;
      message: string;
    };
