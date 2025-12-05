import type { OperationType } from './types';

/**
 * File system error contexts
 */
export interface FileNotFoundContext {
  path: string;
  operation: OperationType;
}

export interface FileExistsContext {
  path: string;
  operation: OperationType;
}

export interface FileSystemContext {
  path: string;
  operation: OperationType;
  stderr?: string;
  exitCode?: number;
}

/**
 * Command error contexts
 */
export interface CommandNotFoundContext {
  command: string;
}

export interface CommandErrorContext {
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Process error contexts
 */
export interface ProcessNotFoundContext {
  processId: string;
}

export interface ProcessErrorContext {
  processId: string;
  pid?: number;
  exitCode?: number;
  stderr?: string;
}

/**
 * Process readiness error contexts
 */
export interface ProcessReadyTimeoutContext {
  processId: string;
  command: string;
  condition: string;
  timeout: number;
}

export interface ProcessExitedBeforeReadyContext {
  processId: string;
  command: string;
  condition: string;
  exitCode: number;
}

/**
 * Port error contexts
 */
export interface PortAlreadyExposedContext {
  port: number;
  portName?: string;
}

export interface PortNotExposedContext {
  port: number;
}

export interface InvalidPortContext {
  port: number;
  reason: string;
}

export interface PortErrorContext {
  port: number;
  portName?: string;
  stderr?: string;
}

/**
 * Git error contexts
 */
export interface GitRepositoryNotFoundContext {
  repository: string; // Full URL
}

export interface GitAuthFailedContext {
  repository: string;
}

export interface GitBranchNotFoundContext {
  branch: string;
  repository?: string;
}

export interface GitErrorContext {
  repository?: string;
  branch?: string;
  targetDir?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * Code interpreter error contexts
 */
export interface InterpreterNotReadyContext {
  retryAfter?: number; // Seconds
  progress?: number; // 0-100
}

export interface ContextNotFoundContext {
  contextId: string;
}

export interface CodeExecutionContext {
  contextId?: string;
  ename?: string; // Error name
  evalue?: string; // Error value
  traceback?: string[]; // Stack trace
}

/**
 * Validation error contexts
 */
export interface ValidationFailedContext {
  validationErrors: Array<{
    field: string;
    message: string;
    code?: string;
  }>;
}

/**
 * Bucket mounting error contexts
 */
export interface BucketMountContext {
  bucket: string;
  mountPath: string;
  endpoint: string;
  stderr?: string;
  exitCode?: number;
}

export interface MissingCredentialsContext {
  bucket: string;
  endpoint: string;
}

export interface InvalidMountConfigContext {
  bucket?: string;
  mountPath?: string;
  endpoint?: string;
  reason?: string;
}

/**
 * Generic error contexts
 */
export interface InternalErrorContext {
  originalError?: string;
  stack?: string;
  [key: string]: unknown; // Allow extension
}
