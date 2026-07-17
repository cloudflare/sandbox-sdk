import type {
  BackupCreateContext,
  BackupExpiredContext,
  BackupNotFoundContext,
  BackupRestoreContext,
  CodeExecutionContext,
  CommandErrorContext,
  CommandNotFoundContext,
  ContainerUnavailableContext,
  ContextNotFoundContext,
  ErrorResponse,
  FileExistsContext,
  FileNotFoundContext,
  FileSystemContext,
  FileTooLargeContext,
  GitAuthFailedContext,
  GitBranchNotFoundContext,
  GitErrorContext,
  GitRepositoryNotFoundContext,
  InternalErrorContext,
  InterpreterNotReadyContext,
  InvalidBackupConfigContext,
  InvalidPortContext,
  InvalidTerminalCursorContext,
  OperationInterruptedContext,
  PortAlreadyExposedContext,
  PortErrorContext,
  PortNotExposedContext,
  ProcessErrorContext,
  ProcessExitedBeforeReadyContext,
  ProcessNotFoundContext,
  ProcessReadyTimeoutContext,
  RPCTransportContext,
  RPCTransportErrorKind,
  TerminalControlErrorContext,
  TerminalNotFoundContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { SandboxError } from './base';
// File System Errors
// ============================================================================

/**
 * Error thrown when a file or directory is not found
 */
export class FileNotFoundError extends SandboxError<FileNotFoundContext> {
  constructor(errorResponse: ErrorResponse<FileNotFoundContext>) {
    super(errorResponse);
    this.name = 'FileNotFoundError';
  }

  // Type-safe accessors
  get path() {
    return this.context.path;
  }
}

/**
 * Error thrown when a file already exists
 */
export class FileExistsError extends SandboxError<FileExistsContext> {
  constructor(errorResponse: ErrorResponse<FileExistsContext>) {
    super(errorResponse);
    this.name = 'FileExistsError';
  }

  // Type-safe accessor
  get path() {
    return this.context.path;
  }
}

/**
 * Error thrown when a file is too large
 */
export class FileTooLargeError extends SandboxError<FileTooLargeContext> {
  constructor(errorResponse: ErrorResponse<FileTooLargeContext>) {
    super(errorResponse);
    this.name = 'FileTooLargeError';
  }

  // Type-safe accessor
  get path() {
    return this.context.path;
  }
}

/**
 * Generic file system error (permissions, disk full, etc.)
 */
export class FileSystemError extends SandboxError<FileSystemContext> {
  constructor(errorResponse: ErrorResponse<FileSystemContext>) {
    super(errorResponse);
    this.name = 'FileSystemError';
  }

  // Type-safe accessors
  get path() {
    return this.context.path;
  }
  get stderr() {
    return this.context.stderr;
  }
  get exitCode() {
    return this.context.exitCode;
  }
}

/**
 * Error thrown when permission is denied
 */
export class PermissionDeniedError extends SandboxError<FileSystemContext> {
  constructor(errorResponse: ErrorResponse<FileSystemContext>) {
    super(errorResponse);
    this.name = 'PermissionDeniedError';
  }

  get path() {
    return this.context.path;
  }
}

// ============================================================================
