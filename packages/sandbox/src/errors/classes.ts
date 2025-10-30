/**
 * Type-safe error classes that wrap ErrorResponse from container
 *
 * All error classes extend SandboxError<TContext> which wraps the full ErrorResponse
 * and provides type-safe accessors for error properties.
 */

import type {
  CodeExecutionContext,
  CommandErrorContext,
  CommandNotFoundContext,
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
  InvalidPortContext,
  PortAlreadyExposedContext,
  PortErrorContext,
  PortNotExposedContext,
  ProcessErrorContext,
  ProcessNotFoundContext,
  ValidationFailedContext
} from '@repo/shared/errors';

/**
 * Base SDK error that wraps ErrorResponse
 * Preserves all error information from container
 */
export class SandboxError<TContext = Record<string, unknown>> extends Error {
  constructor(public readonly errorResponse: ErrorResponse<TContext>) {
    super(errorResponse.message);
    this.name = 'SandboxError';
  }

  // Convenience accessors
  get code() {
    return this.errorResponse.code;
  }
  get context() {
    return this.errorResponse.context;
  }
  get httpStatus() {
    return this.errorResponse.httpStatus;
  }
  get operation() {
    return this.errorResponse.operation;
  }
  get suggestion() {
    return this.errorResponse.suggestion;
  }
  get timestamp() {
    return this.errorResponse.timestamp;
  }
  get documentation() {
    return this.errorResponse.documentation;
  }

  // Custom serialization for logging
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      httpStatus: this.httpStatus,
      operation: this.operation,
      suggestion: this.suggestion,
      timestamp: this.timestamp,
      documentation: this.documentation,
      stack: this.stack
    };
  }
}

// ============================================================================
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
// Command Errors
// ============================================================================

/**
 * Error thrown when a command is not found
 */
export class CommandNotFoundError extends SandboxError<CommandNotFoundContext> {
  constructor(errorResponse: ErrorResponse<CommandNotFoundContext>) {
    super(errorResponse);
    this.name = 'CommandNotFoundError';
  }

  // Type-safe accessor
  get command() {
    return this.context.command;
  }
}

/**
 * Generic command execution error
 */
export class CommandError extends SandboxError<CommandErrorContext> {
  constructor(errorResponse: ErrorResponse<CommandErrorContext>) {
    super(errorResponse);
    this.name = 'CommandError';
  }

  // Type-safe accessors
  get command() {
    return this.context.command;
  }
  get exitCode() {
    return this.context.exitCode;
  }
  get stdout() {
    return this.context.stdout;
  }
  get stderr() {
    return this.context.stderr;
  }
}

// ============================================================================
// Process Errors
// ============================================================================

/**
 * Error thrown when a process is not found
 */
export class ProcessNotFoundError extends SandboxError<ProcessNotFoundContext> {
  constructor(errorResponse: ErrorResponse<ProcessNotFoundContext>) {
    super(errorResponse);
    this.name = 'ProcessNotFoundError';
  }

  // Type-safe accessor
  get processId() {
    return this.context.processId;
  }
}

/**
 * Generic process error
 */
export class ProcessError extends SandboxError<ProcessErrorContext> {
  constructor(errorResponse: ErrorResponse<ProcessErrorContext>) {
    super(errorResponse);
    this.name = 'ProcessError';
  }

  // Type-safe accessors
  get processId() {
    return this.context.processId;
  }
  get pid() {
    return this.context.pid;
  }
  get exitCode() {
    return this.context.exitCode;
  }
  get stderr() {
    return this.context.stderr;
  }
}

// ============================================================================
// Port Errors
// ============================================================================

/**
 * Error thrown when a port is already exposed
 */
export class PortAlreadyExposedError extends SandboxError<PortAlreadyExposedContext> {
  constructor(errorResponse: ErrorResponse<PortAlreadyExposedContext>) {
    super(errorResponse);
    this.name = 'PortAlreadyExposedError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get portName() {
    return this.context.portName;
  }
}

/**
 * Error thrown when a port is not exposed
 */
export class PortNotExposedError extends SandboxError<PortNotExposedContext> {
  constructor(errorResponse: ErrorResponse<PortNotExposedContext>) {
    super(errorResponse);
    this.name = 'PortNotExposedError';
  }

  // Type-safe accessor
  get port() {
    return this.context.port;
  }
}

/**
 * Error thrown when a port number is invalid
 */
export class InvalidPortError extends SandboxError<InvalidPortContext> {
  constructor(errorResponse: ErrorResponse<InvalidPortContext>) {
    super(errorResponse);
    this.name = 'InvalidPortError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get reason() {
    return this.context.reason;
  }
}

/**
 * Error thrown when a service on a port is not responding
 */
export class ServiceNotRespondingError extends SandboxError<PortErrorContext> {
  constructor(errorResponse: ErrorResponse<PortErrorContext>) {
    super(errorResponse);
    this.name = 'ServiceNotRespondingError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get portName() {
    return this.context.portName;
  }
}

/**
 * Error thrown when a port is already in use
 */
export class PortInUseError extends SandboxError<PortErrorContext> {
  constructor(errorResponse: ErrorResponse<PortErrorContext>) {
    super(errorResponse);
    this.name = 'PortInUseError';
  }

  // Type-safe accessor
  get port() {
    return this.context.port;
  }
}

/**
 * Generic port operation error
 */
export class PortError extends SandboxError<PortErrorContext> {
  constructor(errorResponse: ErrorResponse<PortErrorContext>) {
    super(errorResponse);
    this.name = 'PortError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get portName() {
    return this.context.portName;
  }
  get stderr() {
    return this.context.stderr;
  }
}

/**
 * Error thrown when port exposure requires a custom domain
 */
export class CustomDomainRequiredError extends SandboxError<InternalErrorContext> {
  constructor(errorResponse: ErrorResponse<InternalErrorContext>) {
    super(errorResponse);
    this.name = 'CustomDomainRequiredError';
  }
}

// ============================================================================
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
