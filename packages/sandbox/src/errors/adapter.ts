/**
 * Error adapter that converts ErrorResponse to appropriate Error class
 *
 * Simple switch statement - we trust the container sends correct context
 * No validation overhead since we control both sides
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
  FileTooLargeContext,
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
  SessionAlreadyExistsContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';

import {
  CodeExecutionError,
  CommandError,
  CommandNotFoundError,
  ContextNotFoundError,
  CustomDomainRequiredError,
  FileExistsError,
  FileNotFoundError,
  FileSystemError,
  FileTooLargeError,
  GitAuthenticationError,
  GitBranchNotFoundError,
  GitCheckoutError,
  GitCloneError,
  GitError,
  GitNetworkError,
  GitRepositoryNotFoundError,
  InterpreterNotReadyError,
  InvalidGitUrlError,
  InvalidPortError,
  PermissionDeniedError,
  PortAlreadyExposedError,
  PortError,
  PortInUseError,
  PortNotExposedError,
  ProcessError,
  ProcessNotFoundError,
  SandboxError,
  ServiceNotRespondingError,
  SessionAlreadyExistsError,
  ValidationFailedError
} from './classes';

/**
 * Convert ErrorResponse to appropriate Error class
 * Simple switch statement - we trust the container sends correct context
 */
export function createErrorFromResponse(errorResponse: ErrorResponse): Error {
  // We trust the container sends correct context, use type assertions
  switch (errorResponse.code) {
    // File System Errors
    case ErrorCode.FILE_NOT_FOUND:
      return new FileNotFoundError(
        errorResponse as unknown as ErrorResponse<FileNotFoundContext>
      );

    case ErrorCode.FILE_EXISTS:
      return new FileExistsError(
        errorResponse as unknown as ErrorResponse<FileExistsContext>
      );

    case ErrorCode.FILE_TOO_LARGE:
      return new FileTooLargeError(
        errorResponse as unknown as ErrorResponse<FileTooLargeContext>
      );

    case ErrorCode.PERMISSION_DENIED:
      return new PermissionDeniedError(
        errorResponse as unknown as ErrorResponse<FileSystemContext>
      );

    case ErrorCode.IS_DIRECTORY:
    case ErrorCode.NOT_DIRECTORY:
    case ErrorCode.NO_SPACE:
    case ErrorCode.TOO_MANY_FILES:
    case ErrorCode.RESOURCE_BUSY:
    case ErrorCode.READ_ONLY:
    case ErrorCode.NAME_TOO_LONG:
    case ErrorCode.TOO_MANY_LINKS:
    case ErrorCode.FILESYSTEM_ERROR:
      return new FileSystemError(
        errorResponse as unknown as ErrorResponse<FileSystemContext>
      );

    // Command Errors
    case ErrorCode.COMMAND_NOT_FOUND:
      return new CommandNotFoundError(
        errorResponse as unknown as ErrorResponse<CommandNotFoundContext>
      );

    case ErrorCode.COMMAND_PERMISSION_DENIED:
    case ErrorCode.COMMAND_EXECUTION_ERROR:
    case ErrorCode.INVALID_COMMAND:
    case ErrorCode.STREAM_START_ERROR:
      return new CommandError(
        errorResponse as unknown as ErrorResponse<CommandErrorContext>
      );

    // Process Errors
    case ErrorCode.PROCESS_NOT_FOUND:
      return new ProcessNotFoundError(
        errorResponse as unknown as ErrorResponse<ProcessNotFoundContext>
      );

    case ErrorCode.PROCESS_PERMISSION_DENIED:
    case ErrorCode.PROCESS_ERROR:
      return new ProcessError(
        errorResponse as unknown as ErrorResponse<ProcessErrorContext>
      );

    // Session Errors
    case ErrorCode.SESSION_ALREADY_EXISTS:
      return new SessionAlreadyExistsError(
        errorResponse as unknown as ErrorResponse<SessionAlreadyExistsContext>
      );

    // Port Errors
    case ErrorCode.PORT_ALREADY_EXPOSED:
      return new PortAlreadyExposedError(
        errorResponse as unknown as ErrorResponse<PortAlreadyExposedContext>
      );

    case ErrorCode.PORT_NOT_EXPOSED:
      return new PortNotExposedError(
        errorResponse as unknown as ErrorResponse<PortNotExposedContext>
      );

    case ErrorCode.INVALID_PORT_NUMBER:
    case ErrorCode.INVALID_PORT:
      return new InvalidPortError(
        errorResponse as unknown as ErrorResponse<InvalidPortContext>
      );

    case ErrorCode.SERVICE_NOT_RESPONDING:
      return new ServiceNotRespondingError(
        errorResponse as unknown as ErrorResponse<PortErrorContext>
      );

    case ErrorCode.PORT_IN_USE:
      return new PortInUseError(
        errorResponse as unknown as ErrorResponse<PortErrorContext>
      );

    case ErrorCode.PORT_OPERATION_ERROR:
      return new PortError(
        errorResponse as unknown as ErrorResponse<PortErrorContext>
      );

    case ErrorCode.CUSTOM_DOMAIN_REQUIRED:
      return new CustomDomainRequiredError(
        errorResponse as unknown as ErrorResponse<InternalErrorContext>
      );

    // Git Errors
    case ErrorCode.GIT_REPOSITORY_NOT_FOUND:
      return new GitRepositoryNotFoundError(
        errorResponse as unknown as ErrorResponse<GitRepositoryNotFoundContext>
      );

    case ErrorCode.GIT_AUTH_FAILED:
      return new GitAuthenticationError(
        errorResponse as unknown as ErrorResponse<GitAuthFailedContext>
      );

    case ErrorCode.GIT_BRANCH_NOT_FOUND:
      return new GitBranchNotFoundError(
        errorResponse as unknown as ErrorResponse<GitBranchNotFoundContext>
      );

    case ErrorCode.GIT_NETWORK_ERROR:
      return new GitNetworkError(
        errorResponse as unknown as ErrorResponse<GitErrorContext>
      );

    case ErrorCode.GIT_CLONE_FAILED:
      return new GitCloneError(
        errorResponse as unknown as ErrorResponse<GitErrorContext>
      );

    case ErrorCode.GIT_CHECKOUT_FAILED:
      return new GitCheckoutError(
        errorResponse as unknown as ErrorResponse<GitErrorContext>
      );

    case ErrorCode.INVALID_GIT_URL:
      return new InvalidGitUrlError(
        errorResponse as unknown as ErrorResponse<ValidationFailedContext>
      );

    case ErrorCode.GIT_OPERATION_FAILED:
      return new GitError(
        errorResponse as unknown as ErrorResponse<GitErrorContext>
      );

    // Code Interpreter Errors
    case ErrorCode.INTERPRETER_NOT_READY:
      return new InterpreterNotReadyError(
        errorResponse as unknown as ErrorResponse<InterpreterNotReadyContext>
      );

    case ErrorCode.CONTEXT_NOT_FOUND:
      return new ContextNotFoundError(
        errorResponse as unknown as ErrorResponse<ContextNotFoundContext>
      );

    case ErrorCode.CODE_EXECUTION_ERROR:
      return new CodeExecutionError(
        errorResponse as unknown as ErrorResponse<CodeExecutionContext>
      );

    // Validation Errors
    case ErrorCode.VALIDATION_FAILED:
      return new ValidationFailedError(
        errorResponse as unknown as ErrorResponse<ValidationFailedContext>
      );

    // Generic Errors
    case ErrorCode.INVALID_JSON_RESPONSE:
    case ErrorCode.UNKNOWN_ERROR:
    case ErrorCode.INTERNAL_ERROR:
      return new SandboxError(
        errorResponse as unknown as ErrorResponse<InternalErrorContext>
      );

    default:
      // Fallback for unknown error codes
      return new SandboxError(errorResponse);
  }
}
