const LEGACY_SESSIONLESS_SESSION_ID = '__DISABLE_SESSION__';

export type ValidationResult<T = unknown> =
  | {
      isValid: true;
      data: T;
      errors: ValidationError[];
    }
  | {
      isValid: false;
      data?: undefined;
      errors: ValidationError[];
    };

interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export type ServiceResult<T, M = Record<string, unknown>> = T extends void
  ?
      | {
          success: true;
          metadata?: M;
        }
      | {
          success: false;
          error: ServiceError;
        }
  :
      | {
          success: true;
          data: T;
          metadata?: M;
        }
      | {
          success: false;
          error: ServiceError;
        };

export interface ServiceError {
  message: string;
  code: string;
  details?: Record<string, unknown>;
}

/**
 * Helper functions to construct ServiceResult with proper typing.
 * Use these instead of manual object construction to avoid type casts.
 */
export function serviceSuccess<T>(data: T): ServiceResult<T> {
  return { success: true, data } as ServiceResult<T>;
}

export function serviceError<T>(error: ServiceError): ServiceResult<T> {
  return { success: false, error } as ServiceResult<T>;
}

// Process types (enhanced from existing)
export type ProcessStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'error';

export type ExecutionTarget =
  | { kind: 'sessionless' }
  | { kind: 'session'; sessionId: string };

export function resolveExecutionTarget(sessionId?: string): ExecutionTarget {
  if (sessionId === undefined || sessionId === LEGACY_SESSIONLESS_SESSION_ID) {
    return { kind: 'sessionless' };
  }

  if (sessionId.trim().length === 0) {
    throw new Error('sessionId must not be empty or whitespace');
  }

  return { kind: 'session', sessionId };
}

export function getExecutionTargetDisplayName(target: ExecutionTarget): string {
  return target.kind === 'session' ? target.sessionId : 'sessionless';
}

export interface ProcessCommandHandle {
  target: ExecutionTarget;
  commandId: string;
  pid?: number;
}

export type ProcessOutputMode = 'pipe' | 'ignore';
export type ProcessStderrMode = 'pipe' | 'ignore' | 'combined';

export interface ProcessRecord {
  id: string;
  pid?: number;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  sessionId?: string;
  stdout: string;
  stderr: string;
  stdoutMode: ProcessOutputMode;
  stderrMode: ProcessStderrMode;
  outputListeners: Set<(stream: 'stdout' | 'stderr', data: string) => void>;
  statusListeners: Set<(status: ProcessStatus) => void>;
  commandHandle?: ProcessCommandHandle;
  // Promise that resolves when all streaming events have been processed
  streamingComplete?: Promise<void>;
  // For isolation layer (file-based IPC)
  stdoutFile?: string;
  stderrFile?: string;
  monitoringInterval?: Timer;
}

// Process options for container-internal execution (includes session routing)
export interface ProcessOptions {
  sessionId?: string;
  processId?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  encoding?: string;
  autoCleanup?: boolean;
  origin?: 'user' | 'internal';
  stdout?: ProcessOutputMode;
  stderr?: ProcessStderrMode;
  /**
   * Optional standard input stream piped into the spawned process. Bytes
   * are written to a per-command FIFO (or directly into the process's
   * stdin in sessionless mode) until the stream ends, at which point the
   * command's stdin sees EOF.
   */
  stdin?: ReadableStream<Uint8Array>;
}

export interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

// File operation types
export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modified: Date;
  created: Date;
}

export interface FileMetadata {
  encoding: 'utf-8' | 'base64';
  isBinary: boolean;
  mimeType: string;
  size: number;
}

export interface ReadOptions {
  encoding?: string;
}

export interface WriteOptions {
  encoding?: string;
  mode?: string;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: string;
}
