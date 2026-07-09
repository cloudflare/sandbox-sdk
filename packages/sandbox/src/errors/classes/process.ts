import type {
  CommandErrorContext,
  CommandNotFoundContext,
  ErrorResponse,
  InvalidProcessCursorContext,
  InvalidProcessCwdContext,
  InvalidProcessEnvironmentContext,
  ProcessAbortedContext,
  ProcessErrorContext,
  ProcessExitedBeforeLogContext,
  ProcessExitedBeforeReadyContext,
  ProcessNotFoundContext,
  ProcessReadyTimeoutContext,
  ProcessSpawnFailedContext,
  ProcessWaitTimeoutContext,
  StaleProcessHandleContext
} from '@repo/shared/errors';
import { SandboxError } from './base';
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

export class InvalidProcessCwdError extends SandboxError<InvalidProcessCwdContext> {
  constructor(errorResponse: ErrorResponse<InvalidProcessCwdContext>) {
    super(errorResponse);
    this.name = 'InvalidProcessCwdError';
  }
}

export class InvalidProcessEnvironmentError extends SandboxError<InvalidProcessEnvironmentContext> {
  constructor(errorResponse: ErrorResponse<InvalidProcessEnvironmentContext>) {
    super(errorResponse);
    this.name = 'InvalidProcessEnvironmentError';
  }
}

export class InvalidProcessCursorError extends SandboxError<InvalidProcessCursorContext> {
  constructor(errorResponse: ErrorResponse<InvalidProcessCursorContext>) {
    super(errorResponse);
    this.name = 'InvalidProcessCursorError';
  }
}

export class ProcessSpawnFailedError extends SandboxError<ProcessSpawnFailedContext> {
  constructor(errorResponse: ErrorResponse<ProcessSpawnFailedContext>) {
    super(errorResponse);
    this.name = 'ProcessSpawnFailedError';
  }
}

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

export class StaleProcessHandleError extends SandboxError<StaleProcessHandleContext> {
  constructor(errorResponse: ErrorResponse<StaleProcessHandleContext>) {
    super(errorResponse);
    this.name = 'StaleProcessHandleError';
  }

  get processId() {
    return this.context.processId;
  }
  get pid() {
    return this.context.pid;
  }
  get operation() {
    return this.context.operation;
  }
}

export class ProcessWaitTimeoutError extends SandboxError<ProcessWaitTimeoutContext> {
  constructor(errorResponse: ErrorResponse<ProcessWaitTimeoutContext>) {
    super(errorResponse);
    this.name = 'ProcessWaitTimeoutError';
  }

  get processId() {
    return this.context.processId;
  }
  get operation() {
    return this.context.operation;
  }
  get timeout() {
    return this.context.timeout;
  }
}

export class ProcessAbortedError extends SandboxError<ProcessAbortedContext> {
  constructor(errorResponse: ErrorResponse<ProcessAbortedContext>) {
    super(errorResponse);
    this.name = 'ProcessAbortedError';
  }

  get processId() {
    return this.context.processId;
  }
  get operation() {
    return this.context.operation;
  }
}

export class ProcessReadyTimeoutError extends SandboxError<ProcessReadyTimeoutContext> {
  constructor(errorResponse: ErrorResponse<ProcessReadyTimeoutContext>) {
    super(errorResponse);
    this.name = 'ProcessReadyTimeoutError';
  }

  get processId() {
    return this.context.processId;
  }
  get command() {
    return this.context.command;
  }
  get condition() {
    return this.context.condition;
  }
  get timeout() {
    return this.context.timeout;
  }
}

export class ProcessExitedBeforeLogError extends SandboxError<ProcessExitedBeforeLogContext> {
  constructor(errorResponse: ErrorResponse<ProcessExitedBeforeLogContext>) {
    super(errorResponse);
    this.name = 'ProcessExitedBeforeLogError';
  }

  get processId() {
    return this.context.processId;
  }
  get pid() {
    return this.context.pid;
  }
  get exit() {
    return this.context.exit;
  }
}

export class ProcessExitedBeforeReadyError extends SandboxError<ProcessExitedBeforeReadyContext> {
  constructor(errorResponse: ErrorResponse<ProcessExitedBeforeReadyContext>) {
    super(errorResponse);
    this.name = 'ProcessExitedBeforeReadyError';
  }

  get processId() {
    return this.context.processId;
  }
  get command() {
    return this.context.command;
  }
  get condition() {
    return this.context.condition;
  }
  get exitCode() {
    return this.context.exitCode;
  }
}
