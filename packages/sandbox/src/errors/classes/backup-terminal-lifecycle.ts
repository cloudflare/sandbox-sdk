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
  InvalidTerminalCwdContext,
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
  StaleTerminalHandleContext,
  TerminalControlErrorContext,
  TerminalNotFoundContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { SandboxError } from './base';
// Backup Errors
// ============================================================================

/**
 * Error thrown when a backup is not found in R2
 */
export class BackupNotFoundError extends SandboxError<BackupNotFoundContext> {
  constructor(errorResponse: ErrorResponse<BackupNotFoundContext>) {
    super(errorResponse);
    this.name = 'BackupNotFoundError';
  }

  get backupId() {
    return this.context.backupId;
  }
}

/**
 * Error thrown when a backup has expired (past its TTL)
 */
export class BackupExpiredError extends SandboxError<BackupExpiredContext> {
  constructor(errorResponse: ErrorResponse<BackupExpiredContext>) {
    super(errorResponse);
    this.name = 'BackupExpiredError';
  }

  get backupId() {
    return this.context.backupId;
  }
  get expiredAt() {
    return this.context.expiredAt;
  }
}

/**
 * Error thrown when backup configuration or inputs are invalid
 */
export class InvalidBackupConfigError extends SandboxError<InvalidBackupConfigContext> {
  constructor(errorResponse: ErrorResponse<InvalidBackupConfigContext>) {
    super(errorResponse);
    this.name = 'InvalidBackupConfigError';
  }

  get reason() {
    return this.context.reason;
  }
}

/**
 * Error thrown when backup creation fails
 */
export class BackupCreateError extends SandboxError<BackupCreateContext> {
  constructor(errorResponse: ErrorResponse<BackupCreateContext>) {
    super(errorResponse);
    this.name = 'BackupCreateError';
  }

  get dir() {
    return this.context.dir;
  }
  get backupId() {
    return this.context.backupId;
  }
}

/**
 * Error thrown when backup restoration fails
 */
export class BackupRestoreError extends SandboxError<BackupRestoreContext> {
  constructor(errorResponse: ErrorResponse<BackupRestoreContext>) {
    super(errorResponse);
    this.name = 'BackupRestoreError';
  }

  get dir() {
    return this.context.dir;
  }
  get backupId() {
    return this.context.backupId;
  }
}

// ============================================================================
// Terminal Errors
// ============================================================================

export class TerminalNotFoundError extends SandboxError<TerminalNotFoundContext> {
  constructor(errorResponse: ErrorResponse<TerminalNotFoundContext>) {
    super(errorResponse);
    this.name = 'TerminalNotFoundError';
  }

  get terminalId() {
    return this.context.terminalId;
  }
}

export class InvalidTerminalCwdError extends SandboxError<InvalidTerminalCwdContext> {
  constructor(errorResponse: ErrorResponse<InvalidTerminalCwdContext>) {
    super(errorResponse);
    this.name = 'InvalidTerminalCwdError';
  }

  get terminalId() {
    return this.context.terminalId;
  }

  get cwd() {
    return this.context.cwd;
  }
}

export class InvalidTerminalCursorError extends SandboxError<InvalidTerminalCursorContext> {
  constructor(errorResponse: ErrorResponse<InvalidTerminalCursorContext>) {
    super(errorResponse);
    this.name = 'InvalidTerminalCursorError';
  }

  get terminalId() {
    return this.context.terminalId;
  }
}

export class TerminalControlError extends SandboxError<TerminalControlErrorContext> {
  constructor(errorResponse: ErrorResponse<TerminalControlErrorContext>) {
    super(errorResponse);
    this.name = 'TerminalControlError';
  }

  get terminalId() {
    return this.context.terminalId;
  }

  get operationName() {
    return this.context.operation;
  }
}

export class StaleTerminalHandleError extends SandboxError<StaleTerminalHandleContext> {
  constructor(errorResponse: ErrorResponse<StaleTerminalHandleContext>) {
    super(errorResponse);
    this.name = 'StaleTerminalHandleError';
  }

  get terminalId() {
    return this.context.terminalId;
  }

  get operation() {
    return this.context.operation;
  }
}

// ============================================================================
// Container Availability Errors
// ============================================================================

export class ContainerUnavailableError extends SandboxError<ContainerUnavailableContext> {
  constructor(errorResponse: ErrorResponse<ContainerUnavailableContext>) {
    super(errorResponse);
    this.name = 'ContainerUnavailableError';
  }
}

// ============================================================================
// Operation Lifecycle Errors
// ============================================================================

export class OperationInterruptedError extends SandboxError<OperationInterruptedContext> {
  constructor(errorResponse: ErrorResponse<OperationInterruptedContext>) {
    super(errorResponse);
    this.name = 'OperationInterruptedError';
  }

  get reason() {
    return this.context.reason;
  }

  get retryable() {
    return this.context.retryable;
  }

  get operationName() {
    return this.context.operation;
  }
}

// ============================================================================
// RPC Transport Errors (SDK-side)
// ============================================================================

/**
 * Raised when the capnweb WebSocket session itself fails on the SDK side.
 * Unlike the rest of the SandboxError tree, the container never produces
 * this error — it is synthesised by `translateRPCError` from the plain
 * Errors capnweb / DeferredTransport raise when the connection dies.
 *
 * `kind` distinguishes the failure mode (peer close, upgrade failed, etc.)
 * so callers can branch on a structured code instead of substring-matching
 * on the message.
 *
 * Always retryable: the SDK opens a fresh connection on the next call.
 */
export class RPCTransportError extends SandboxError<RPCTransportContext> {
  constructor(
    errorResponse: ErrorResponse<RPCTransportContext>,
    options?: { cause?: unknown }
  ) {
    super(errorResponse, options);
    this.name = 'RPCTransportError';
  }

  get kind(): RPCTransportErrorKind {
    return this.errorResponse.context.kind;
  }

  get originalMessage(): string {
    return this.errorResponse.context.originalMessage;
  }
}
