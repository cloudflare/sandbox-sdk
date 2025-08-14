import type { ChildProcess } from "node:child_process";

// Process management types
export type ProcessStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'error';

export interface ProcessRecord {
  id: string;
  pid?: number;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  stdoutFile?: string;  // Path to temp file containing stdout
  stderrFile?: string;  // Path to temp file containing stderr
  stdout: string;
  stderr: string;
  outputListeners: Set<(stream: 'stdout' | 'stderr', data: string) => void>;
  statusListeners: Set<(status: ProcessStatus) => void>;
  monitoringInterval?: NodeJS.Timeout;  // For polling temp files when streaming
}

export interface StartProcessRequest {
  command: string;
  sessionId?: string;  // Optional session context for process
  options?: {
    processId?: string;
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
    encoding?: string;
    autoCleanup?: boolean;
  };
}

export interface ExecuteOptions {
  background?: boolean;
  cwd?: string | URL;
  env?: Record<string, string>;
}

export interface ExecuteRequest extends ExecuteOptions {
  command: string;
  sessionId?: string;  // Optional session context for streaming
}

export interface GitCheckoutRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  sessionId?: string;  // Optional session context
}

export interface MkdirRequest {
  path: string;
  recursive?: boolean;
  sessionId?: string;  // Optional session context
}

export interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: string;
  sessionId?: string;  // Optional session context
}

export interface ReadFileRequest {
  path: string;
  encoding?: string;
  sessionId?: string;  // Optional session context
}

export interface DeleteFileRequest {
  path: string;
  sessionId?: string;  // Optional session context
}

export interface RenameFileRequest {
  oldPath: string;
  newPath: string;
  sessionId?: string;  // Optional session context
}

export interface MoveFileRequest {
  sourcePath: string;
  destinationPath: string;
  sessionId?: string;  // Optional session context
}

export interface ListFilesRequest {
  path: string;
  options?: {
    recursive?: boolean;
    includeHidden?: boolean;
  };
  sessionId?: string;  // Optional session context
}

export interface ExposePortRequest {
  port: number;
  name?: string;
}

export interface UnexposePortRequest {
  port: number;
}

export interface SessionData {
  id: string;
  activeProcess: ChildProcess | null;
  createdAt: Date;
}

// Session management API types
export interface CreateSessionRequest {
  id: string;
  env?: Record<string, string>;
  cwd?: string;
  isolation?: boolean;
}

export interface SessionExecRequest {
  id: string;
  command: string;
}
