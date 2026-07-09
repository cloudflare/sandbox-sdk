import type { ChildProcess } from 'node:child_process';

/** Minimal logger so the sidecar stays free of host logging dependencies. */
export interface SidecarLogger {
  debug: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, error?: unknown, meta?: unknown) => void;
}

export const noopLogger: SidecarLogger = {
  debug() {},
  warn() {},
  error() {}
};

export type InterpreterLanguage = 'python' | 'javascript' | 'typescript';

export interface InterpreterProcess {
  id: string;
  language: InterpreterLanguage;
  process: ChildProcess;
  sessionId?: string;
  lastUsed: Date;
  exitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  success: boolean;
  executionId: string;
  outputs?: RichOutput[];
  error?: {
    type: string;
    message: string;
    traceback?: string;
  };
}

export interface RichOutput {
  type:
    | 'text'
    | 'image'
    | 'jpeg'
    | 'svg'
    | 'html'
    | 'json'
    | 'latex'
    | 'markdown'
    | 'javascript'
    | 'error';
  data: string;
  metadata?: Record<string, unknown>;
}

export interface PoolConfig {
  maxProcesses?: number;
  idleTimeout: number;
  minSize: number;
}

export interface ExecutorPoolConfig extends PoolConfig {
  executor: InterpreterLanguage;
}
