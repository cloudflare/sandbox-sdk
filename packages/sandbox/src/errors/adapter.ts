/**
 * Error adapter that converts ErrorResponse to appropriate Error class
 *
 * Simple switch statement - we trust the container sends correct context
 * No validation overhead since we control both sides
 */

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
  InvalidProcessCursorContext,
  InvalidProcessCwdContext,
  InvalidProcessEnvironmentContext,
  InvalidTerminalCursorContext,
  InvalidTerminalCwdContext,
  OperationInterruptedContext,
  PortAlreadyExposedContext,
  PortErrorContext,
  PortNotExposedContext,
  ProcessAbortedContext,
  ProcessErrorContext,
  ProcessNotFoundContext,
  ProcessSpawnFailedContext,
  ProcessWaitTimeoutContext,
  RPCTransportContext,
  StaleProcessHandleContext,
  StaleTerminalHandleContext,
  TerminalControlErrorContext,
  TerminalNotFoundContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';

import {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  CodeExecutionError,
  CommandError,
  CommandNotFoundError,
  ContainerUnavailableError,
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
  PortAlreadyExposedError,
  PortError,
  PortInUseError,
  PortNotExposedError,
  ProcessAbortedError,
  ProcessError,
  ProcessNotFoundError,
  ProcessSpawnFailedError,
  ProcessWaitTimeoutError,
  RPCTransportError,
  SandboxError,
  ServiceNotRespondingError,
  StaleProcessHandleError,
  StaleTerminalHandleError,
  TerminalControlError,
  TerminalNotFoundError,
  ValidationFailedError
} from './classes';

type StaleProcessHandleResponse = ErrorResponse<StaleProcessHandleContext> & {
  code: typeof ErrorCode.STALE_PROCESS_HANDLE;
};

type StaleTerminalHandleResponse = ErrorResponse<StaleTerminalHandleContext> & {
  code: typeof ErrorCode.STALE_TERMINAL_HANDLE;
};

type ProcessWaitTimeoutResponse = ErrorResponse<ProcessWaitTimeoutContext> & {
  code: typeof ErrorCode.PROCESS_WAIT_TIMEOUT;
};

type ProcessAbortedResponse = ErrorResponse<ProcessAbortedContext> & {
  code: typeof ErrorCode.PROCESS_ABORTED;
};

type ProcessErrorResponse =
  | ErrorResponse
  | StaleProcessHandleResponse
  | StaleTerminalHandleResponse
  | ProcessWaitTimeoutResponse
  | ProcessAbortedResponse;

function isStaleProcessHandleResponse(
  errorResponse: ProcessErrorResponse
): errorResponse is StaleProcessHandleResponse {
  const { context } = errorResponse;
  return (
    errorResponse.code === ErrorCode.STALE_PROCESS_HANDLE &&
    'processId' in context &&
    typeof context.processId === 'string' &&
    'pid' in context &&
    typeof context.pid === 'number' &&
    'operation' in context &&
    typeof context.operation === 'string'
  );
}

function isStaleTerminalHandleResponse(
  errorResponse: ProcessErrorResponse
): errorResponse is StaleTerminalHandleResponse {
  const { context } = errorResponse;
  return (
    errorResponse.code === ErrorCode.STALE_TERMINAL_HANDLE &&
    'terminalId' in context &&
    typeof context.terminalId === 'string' &&
    'operation' in context &&
    typeof context.operation === 'string'
  );
}

function isProcessWaitTimeoutResponse(
  errorResponse: ProcessErrorResponse
): errorResponse is ProcessWaitTimeoutResponse {
  const { context } = errorResponse;
  return (
    errorResponse.code === ErrorCode.PROCESS_WAIT_TIMEOUT &&
    'processId' in context &&
    typeof context.processId === 'string' &&
    'operation' in context &&
    (context.operation === 'output' ||
      context.operation === 'waitForExit' ||
      context.operation === 'waitForLog') &&
    'timeout' in context &&
    typeof context.timeout === 'number'
  );
}

function isProcessAbortedResponse(
  errorResponse: ProcessErrorResponse
): errorResponse is ProcessAbortedResponse {
  const { context } = errorResponse;
  return (
    errorResponse.code === ErrorCode.PROCESS_ABORTED &&
    'processId' in context &&
    typeof context.processId === 'string' &&
    'operation' in context &&
    typeof context.operation === 'string'
  );
}

/**
 * Convert ErrorResponse to appropriate Error class
 * Simple switch statement - we trust the container sends correct context
 */
export function createErrorFromResponse<TContext>(
  errorResponse: ErrorResponse<TContext>,
  options?: { cause?: unknown }
): Error {
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
    case ErrorCode.INVALID_PROCESS_CWD:
      return new InvalidProcessCwdError(
        errorResponse as unknown as ErrorResponse<InvalidProcessCwdContext>
      );

    case ErrorCode.INVALID_PROCESS_ENVIRONMENT:
      return new InvalidProcessEnvironmentError(
        errorResponse as unknown as ErrorResponse<InvalidProcessEnvironmentContext>
      );

    case ErrorCode.INVALID_PROCESS_CURSOR:
      return new InvalidProcessCursorError(
        errorResponse as unknown as ErrorResponse<InvalidProcessCursorContext>
      );

    case ErrorCode.PROCESS_SPAWN_FAILED:
      return new ProcessSpawnFailedError(
        errorResponse as unknown as ErrorResponse<ProcessSpawnFailedContext>
      );

    case ErrorCode.PROCESS_NOT_FOUND:
      return new ProcessNotFoundError(
        errorResponse as unknown as ErrorResponse<ProcessNotFoundContext>
      );

    case ErrorCode.STALE_PROCESS_HANDLE:
      if (
        isStaleProcessHandleResponse(
          errorResponse as unknown as ProcessErrorResponse
        )
      ) {
        return new StaleProcessHandleError(
          errorResponse as unknown as StaleProcessHandleResponse
        );
      }
      return new SandboxError(errorResponse);

    case ErrorCode.STALE_TERMINAL_HANDLE:
      if (
        isStaleTerminalHandleResponse(
          errorResponse as unknown as ProcessErrorResponse
        )
      ) {
        return new StaleTerminalHandleError(
          errorResponse as unknown as StaleTerminalHandleResponse
        );
      }
      return new SandboxError(errorResponse);

    case ErrorCode.PROCESS_WAIT_TIMEOUT:
      if (
        isProcessWaitTimeoutResponse(
          errorResponse as unknown as ProcessErrorResponse
        )
      ) {
        return new ProcessWaitTimeoutError(
          errorResponse as unknown as ProcessWaitTimeoutResponse
        );
      }
      return new SandboxError(errorResponse);

    case ErrorCode.PROCESS_ABORTED:
      if (
        isProcessAbortedResponse(
          errorResponse as unknown as ProcessErrorResponse
        )
      ) {
        return new ProcessAbortedError(
          errorResponse as unknown as ProcessAbortedResponse
        );
      }
      return new SandboxError(errorResponse);

    // Terminal Errors
    case ErrorCode.TERMINAL_NOT_FOUND:
      return new TerminalNotFoundError(
        errorResponse as unknown as ErrorResponse<TerminalNotFoundContext>
      );

    case ErrorCode.INVALID_TERMINAL_CWD:
      return new InvalidTerminalCwdError(
        errorResponse as unknown as ErrorResponse<InvalidTerminalCwdContext>
      );

    case ErrorCode.INVALID_TERMINAL_CURSOR:
      return new InvalidTerminalCursorError(
        errorResponse as unknown as ErrorResponse<InvalidTerminalCursorContext>
      );

    case ErrorCode.TERMINAL_CONTROL_ERROR:
      return new TerminalControlError(
        errorResponse as unknown as ErrorResponse<TerminalControlErrorContext>
      );

    case ErrorCode.PROCESS_PERMISSION_DENIED:
    case ErrorCode.PROCESS_ERROR:
      return new ProcessError(
        errorResponse as unknown as ErrorResponse<ProcessErrorContext>
      );

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

    // Backup Errors
    case ErrorCode.BACKUP_NOT_FOUND:
      return new BackupNotFoundError(
        errorResponse as unknown as ErrorResponse<BackupNotFoundContext>
      );

    case ErrorCode.BACKUP_EXPIRED:
      return new BackupExpiredError(
        errorResponse as unknown as ErrorResponse<BackupExpiredContext>
      );

    case ErrorCode.INVALID_BACKUP_CONFIG:
      return new InvalidBackupConfigError(
        errorResponse as unknown as ErrorResponse<InvalidBackupConfigContext>
      );

    case ErrorCode.BACKUP_CREATE_FAILED:
      return new BackupCreateError(
        errorResponse as unknown as ErrorResponse<BackupCreateContext>
      );

    case ErrorCode.BACKUP_RESTORE_FAILED:
      return new BackupRestoreError(
        errorResponse as unknown as ErrorResponse<BackupRestoreContext>
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

    case ErrorCode.CONTAINER_UNAVAILABLE:
      return new ContainerUnavailableError(
        errorResponse as unknown as ErrorResponse<ContainerUnavailableContext>
      );

    case ErrorCode.OPERATION_INTERRUPTED:
      return new OperationInterruptedError(
        errorResponse as unknown as ErrorResponse<OperationInterruptedContext>
      );

    // RPC Transport Errors (SDK-side, raised by translateRPCError on
    // capnweb / DeferredTransport WebSocket failures).
    case ErrorCode.RPC_TRANSPORT_ERROR:
      return new RPCTransportError(
        errorResponse as unknown as ErrorResponse<RPCTransportContext>,
        options
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
