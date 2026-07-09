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
  ProcessNotFoundContext,
  RPCTransportContext,
  RPCTransportErrorKind,
  TerminalControlErrorContext,
  TerminalNotFoundContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { SandboxError } from './base';
// Git Errors
// ============================================================================

/**
 * Error thrown when a git repository is not found
 */
export class GitRepositoryNotFoundError extends SandboxError<GitRepositoryNotFoundContext> {
  constructor(errorResponse: ErrorResponse<GitRepositoryNotFoundContext>) {
    super(errorResponse);
    this.name = 'GitRepositoryNotFoundError';
  }

  // Type-safe accessor
  get repository() {
    return this.context.repository;
  }
}

/**
 * Error thrown when git authentication fails
 */
export class GitAuthenticationError extends SandboxError<GitAuthFailedContext> {
  constructor(errorResponse: ErrorResponse<GitAuthFailedContext>) {
    super(errorResponse);
    this.name = 'GitAuthenticationError';
  }

  // Type-safe accessor
  get repository() {
    return this.context.repository;
  }
}

/**
 * Error thrown when a git branch is not found
 */
export class GitBranchNotFoundError extends SandboxError<GitBranchNotFoundContext> {
  constructor(errorResponse: ErrorResponse<GitBranchNotFoundContext>) {
    super(errorResponse);
    this.name = 'GitBranchNotFoundError';
  }

  // Type-safe accessors
  get branch() {
    return this.context.branch;
  }
  get repository() {
    return this.context.repository;
  }
}

/**
 * Error thrown when a git network operation fails
 */
export class GitNetworkError extends SandboxError<GitErrorContext> {
  constructor(errorResponse: ErrorResponse<GitErrorContext>) {
    super(errorResponse);
    this.name = 'GitNetworkError';
  }

  // Type-safe accessors
  get repository() {
    return this.context.repository;
  }
  get branch() {
    return this.context.branch;
  }
  get targetDir() {
    return this.context.targetDir;
  }
}

/**
 * Error thrown when git clone fails
 */
export class GitCloneError extends SandboxError<GitErrorContext> {
  constructor(errorResponse: ErrorResponse<GitErrorContext>) {
    super(errorResponse);
    this.name = 'GitCloneError';
  }

  // Type-safe accessors
  get repository() {
    return this.context.repository;
  }
  get targetDir() {
    return this.context.targetDir;
  }
  get stderr() {
    return this.context.stderr;
  }
  get exitCode() {
    return this.context.exitCode;
  }
}

/**
 * Error thrown when git checkout fails
 */
export class GitCheckoutError extends SandboxError<GitErrorContext> {
  constructor(errorResponse: ErrorResponse<GitErrorContext>) {
    super(errorResponse);
    this.name = 'GitCheckoutError';
  }

  // Type-safe accessors
  get branch() {
    return this.context.branch;
  }
  get repository() {
    return this.context.repository;
  }
  get stderr() {
    return this.context.stderr;
  }
}

/**
 * Error thrown when a git URL is invalid
 */
export class InvalidGitUrlError extends SandboxError<ValidationFailedContext> {
  constructor(errorResponse: ErrorResponse<ValidationFailedContext>) {
    super(errorResponse);
    this.name = 'InvalidGitUrlError';
  }

  // Type-safe accessor
  get validationErrors() {
    return this.context.validationErrors;
  }
}

/**
 * Generic git operation error
 */
export class GitError extends SandboxError<GitErrorContext> {
  constructor(errorResponse: ErrorResponse<GitErrorContext>) {
    super(errorResponse);
    this.name = 'GitError';
  }

  // Type-safe accessors
  get repository() {
    return this.context.repository;
  }
  get branch() {
    return this.context.branch;
  }
  get targetDir() {
    return this.context.targetDir;
  }
  get stderr() {
    return this.context.stderr;
  }
  get exitCode() {
    return this.context.exitCode;
  }
}

// ============================================================================
// Code Interpreter Errors
// ============================================================================

/**
 * Error thrown when interpreter is not ready
 */
export class InterpreterNotReadyError extends SandboxError<InterpreterNotReadyContext> {
  constructor(errorResponse: ErrorResponse<InterpreterNotReadyContext>) {
    super(errorResponse);
    this.name = 'InterpreterNotReadyError';
  }

  // Type-safe accessors
  get retryAfter() {
    return this.context.retryAfter;
  }
  get progress() {
    return this.context.progress;
  }
}

/**
 * Error thrown when a context is not found
 */
export class ContextNotFoundError extends SandboxError<ContextNotFoundContext> {
  constructor(errorResponse: ErrorResponse<ContextNotFoundContext>) {
    super(errorResponse);
    this.name = 'ContextNotFoundError';
  }

  // Type-safe accessor
  get contextId() {
    return this.context.contextId;
  }
}

/**
 * Error thrown when code execution fails
 */
export class CodeExecutionError extends SandboxError<CodeExecutionContext> {
  constructor(errorResponse: ErrorResponse<CodeExecutionContext>) {
    super(errorResponse);
    this.name = 'CodeExecutionError';
  }

  // Type-safe accessors
  get contextId() {
    return this.context.contextId;
  }
  get ename() {
    return this.context.ename;
  }
  get evalue() {
    return this.context.evalue;
  }
  get traceback() {
    return this.context.traceback;
  }
}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Error thrown when validation fails
 */
export class ValidationFailedError extends SandboxError<ValidationFailedContext> {
  constructor(errorResponse: ErrorResponse<ValidationFailedContext>) {
    super(errorResponse);
    this.name = 'ValidationFailedError';
  }

  // Type-safe accessor
  get validationErrors() {
    return this.context.validationErrors;
  }
}
