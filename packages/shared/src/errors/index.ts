/**
 * Centralized Error System
 *
 * This module provides a type-safe, centralized error handling system used by both
 * the container runtime and client SDK.
 *
 * @example Container Usage
 * ```typescript
 * import { ErrorCode, type ServiceError } from '@repo/shared/errors';
 *
 * const error: ServiceError = {
 *   message: 'File not found',
 *   code: ErrorCode.FILE_NOT_FOUND,
 *   details: { path: '/workspace/file.txt', operation: 'file.read' }
 * };
 * ```
 *
 * @example Client SDK Usage
 * ```typescript
 * import { ErrorCode, type ErrorResponse } from '@repo/shared/errors';
 *
 * try {
 *   await sandbox.file.read('/missing.txt');
 * } catch (error) {
 *   if (error.errorResponse.code === ErrorCode.FILE_NOT_FOUND) {
 *     console.log(error.errorResponse.context.path); // Type-safe!
 *   }
 * }
 * ```
 */

// Export error codes
export { ErrorCode, type ErrorCode as ErrorCodeType } from './codes';
// Export context interfaces
export type {
  CodeExecutionContext,
  CommandErrorContext,
  CommandNotFoundContext,
  ContextNotFoundContext,
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
} from './contexts';
// Export utility functions
export { ERROR_STATUS_MAP, getHttpStatus } from './status-map';
export { getSuggestion } from './suggestions';
// Export core types
export {
  type ErrorResponse,
  Operation,
  type OperationType,
  type ServiceError,
  type ServiceResult
} from './types';
