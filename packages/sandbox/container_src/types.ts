import type { ChildProcess } from "node:child_process";

// Process management types
export type ProcessStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "error";

export interface ProcessRecord {
  id: string;
  pid?: number;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  sessionId?: string;
  childProcess?: ChildProcess;
  stdout: string;
  stderr: string;
  outputListeners: Set<(stream: "stdout" | "stderr", data: string) => void>;
  statusListeners: Set<(status: ProcessStatus) => void>;
}

export interface StartProcessRequest {
  command: string;
  options?: {
    processId?: string;
    sessionId?: string;
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
    encoding?: string;
    autoCleanup?: boolean;
  };
}

export interface ExecuteRequest {
  command: string;
  sessionId?: string;
  background?: boolean;
}

export interface GitCheckoutRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  sessionId?: string;
}

export interface MkdirRequest {
  path: string;
  recursive?: boolean;
  sessionId?: string;
}

export interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: string;
  sessionId?: string;
}

export interface ReadFileRequest {
  path: string;
  encoding?: string;
  sessionId?: string;
}

export interface DeleteFileRequest {
  path: string;
  sessionId?: string;
}

export interface RenameFileRequest {
  oldPath: string;
  newPath: string;
  sessionId?: string;
}

export interface MoveFileRequest {
  sourcePath: string;
  destinationPath: string;
  sessionId?: string;
}

export interface ExposePortRequest {
  port: number;
  name?: string;
}

export interface UnexposePortRequest {
  port: number;
}

export interface SessionData {
  sessionId: string;
  activeProcess: ChildProcess | null;
  createdAt: Date;
}
