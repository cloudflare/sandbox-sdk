/**
 * SDK Error System
 *
 * This module provides type-safe error classes that wrap ErrorResponse from the container.
 * All error classes provide:
 * - Type-safe accessors for error context
 * - instanceof checks for error handling
 * - Full ErrorResponse preservation via errorResponse property
 * - Custom toJSON() for logging
 *
 * @example Basic error handling
 * ```typescript
 * import { FileNotFoundError } from './errors';
 *
 * try {
 *   await sandbox.file.read('/missing.txt');
 * } catch (error) {
 *   if (error instanceof FileNotFoundError) {
 *     console.log(error.path);         // Type-safe! string
 *     console.log(error.operation);    // Type-safe! OperationType
 *     console.log(error.code);         // "FILE_NOT_FOUND"
 *     console.log(error.suggestion);   // Helpful message
 *   }
 * }
 * ```
 *
 * @example Error serialization
 * ```typescript
 * try {
 *   await sandbox.file.read('/missing.txt');
 * } catch (error) {
 *   // Full context available
 *   console.log(error.errorResponse);
 *
 *   // Pretty-prints with custom toJSON
 *   console.log(JSON.stringify(error, null, 2));
 * }
 * ```
 */

// Re-export context types for advanced usage
export type {
  BackupCreateContext,
  BackupExpiredContext,
  BackupNotFoundContext,
  BackupRestoreContext,
  CodeExecutionContext,
  CommandErrorContext,
  CommandNotFoundContext,
  ContainerUnavailableContext,
  ContextNotFoundContext,
  ErrorCode as ErrorCodeType,
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
  InvalidProcessCursorContext,
  InvalidProcessCwdContext,
  InvalidProcessEnvironmentContext,
  InvalidTerminalCursorContext,
  InvalidTerminalCwdContext,
  OperationInterruptedContext,
  OperationInterruptedReason,
  OperationType,
  PortAlreadyExposedContext,
  PortErrorContext,
  PortNotExposedContext,
  ProcessAbortedContext,
  ProcessErrorContext,
  ProcessExitedBeforeLogContext,
  ProcessExitedBeforeReadyContext,
  ProcessNotFoundContext,
  ProcessReadyTimeoutContext,
  ProcessSpawnFailedContext,
  ProcessWaitTimeoutContext,
  RPCTransportContext,
  RPCTransportErrorKind,
  StaleProcessHandleContext,
  StaleTerminalHandleContext,
  TerminalControlErrorContext,
  TerminalNotFoundContext,
  ValidationFailedContext
} from '@repo/shared/errors';
export { ErrorCode, Operation } from '@repo/shared/errors';

// Export adapter function
export { createErrorFromResponse } from './adapter';
// Export all error classes
export {
  // Backup Errors
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  CodeExecutionError,
  CommandError,
  // Command Errors
  CommandNotFoundError,
  ContainerUnavailableError,
  ContextNotFoundError,
  CustomDomainRequiredError,
  FileExistsError,
  // File System Errors
  FileNotFoundError,
  FileSystemError,
  FileTooLargeError,
  GitAuthenticationError,
  GitBranchNotFoundError,
  GitCheckoutError,
  GitCloneError,
  GitError,
  GitNetworkError,
  // Git Errors
  GitRepositoryNotFoundError,
  // Code Interpreter Errors
  InterpreterNotReadyError,
  InvalidBackupConfigError,
  InvalidGitUrlError,
  InvalidPortError,
  InvalidProcessCursorError,
  InvalidProcessCwdError,
  InvalidProcessEnvironmentError,
  InvalidTerminalCursorError,
  InvalidTerminalCwdError,
  OperationInterruptedError,
  PermissionDeniedError,
  // Port Errors
  PortAlreadyExposedError,
  PortError,
  PortInUseError,
  PortNotExposedError,
  // Process Errors
  ProcessAbortedError,
  ProcessError,
  ProcessExitedBeforeLogError,
  // Process Readiness Errors
  ProcessExitedBeforeReadyError,
  ProcessNotFoundError,
  ProcessReadyTimeoutError,
  ProcessSpawnFailedError,
  ProcessWaitTimeoutError,
  // RPC Transport Errors (SDK-side, raised on WebSocket failures)
  RPCTransportError,
  RuntimeControlProtocolError,
  RuntimeIdentityInactiveError,
  SandboxError,
  ServiceNotRespondingError,
  StaleProcessHandleError,
  StaleTerminalHandleError,
  TerminalControlError,
  // Terminal Errors
  TerminalNotFoundError,
  // Validation Errors
  ValidationFailedError
} from './classes';
