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
  CodeExecutionContext,
  CommandErrorContext,
  CommandNotFoundContext,
  ContextNotFoundContext,
  ErrorCodeType,
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
  OperationType,
  PortAlreadyExposedContext,
  PortErrorContext,
  PortNotExposedContext,
  ProcessErrorContext,
  ProcessExitedBeforeReadyContext,
  ProcessNotFoundContext,
  ProcessReadyTimeoutContext,
  ValidationFailedContext
} from '@repo/shared/errors';
// Re-export shared types and constants
export { ErrorCode, Operation } from '@repo/shared/errors';

// Export adapter function
export { createErrorFromResponse } from './adapter';
// Export all error classes
export {
  CodeExecutionError,
  CommandError,
  // Command Errors
  CommandNotFoundError,
  ContextNotFoundError,
  CustomDomainRequiredError,
  FileExistsError,
  // File System Errors
  FileNotFoundError,
  FileSystemError,
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
  InvalidGitUrlError,
  InvalidPortError,
  PermissionDeniedError,
  // Port Errors
  PortAlreadyExposedError,
  PortError,
  PortInUseError,
  PortNotExposedError,
  ProcessError,
  // Process Readiness Errors
  ProcessExitedBeforeReadyError,
  // Process Errors
  ProcessNotFoundError,
  ProcessReadyTimeoutError,
  SandboxError,
  ServiceNotRespondingError,
  // Session Errors
  SessionAlreadyExistsError,
  // Validation Errors
  ValidationFailedError
} from './classes';
