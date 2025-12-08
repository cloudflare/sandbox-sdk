import { ErrorCode } from './codes';

/**
 * Get actionable suggestion for an error code
 * Used by handlers when enriching ServiceError → ErrorResponse
 */
export function getSuggestion(
  code: ErrorCode,
  context: Record<string, unknown>
): string | undefined {
  switch (code) {
    case ErrorCode.FILE_NOT_FOUND:
      return `Ensure the file exists at ${context.path} before attempting to access it`;

    case ErrorCode.FILE_EXISTS:
      return `File already exists at ${context.path}. Use a different path or delete the existing file first`;

    case ErrorCode.COMMAND_NOT_FOUND:
      return `Check that "${context.command}" is installed and available in the system PATH`;

    case ErrorCode.PROCESS_NOT_FOUND:
      return 'Verify the process ID is correct and the process has not already exited';

    case ErrorCode.PORT_NOT_EXPOSED:
      return `Port ${context.port} is not currently exposed. Use listExposedPorts() to see active ports`;

    case ErrorCode.PORT_ALREADY_EXPOSED:
      return `Port ${context.port} is already exposed. Unexpose it first or use a different port`;

    case ErrorCode.PORT_IN_USE:
      return `Port ${context.port} is already in use by another service. Choose a different port`;

    case ErrorCode.SESSION_ALREADY_EXISTS:
      return `Session "${context.sessionId}" already exists. Use a different session ID or reuse the existing session`;

    case ErrorCode.INVALID_PORT:
      return `Port must be between 1 and 65535. Port ${context.port} is ${context.reason}`;

    case ErrorCode.GIT_REPOSITORY_NOT_FOUND:
      return 'Verify the repository URL is correct and accessible';

    case ErrorCode.GIT_AUTH_FAILED:
      return 'Check authentication credentials or use a public repository';

    case ErrorCode.GIT_BRANCH_NOT_FOUND:
      return `Branch "${context.branch}" does not exist in the repository. Check the branch name or use the default branch`;

    case ErrorCode.INTERPRETER_NOT_READY:
      return context.retryAfter
        ? `Code interpreter is starting up. Retry after ${context.retryAfter} seconds`
        : 'Code interpreter is not ready. Please wait a moment and try again';

    case ErrorCode.CONTEXT_NOT_FOUND:
      return `Context "${context.contextId}" does not exist. Create a context first using createContext()`;

    case ErrorCode.VALIDATION_FAILED:
      return 'Check the request parameters and ensure they match the required format';

    case ErrorCode.NO_SPACE:
      return 'Not enough disk space available. Consider cleaning up temporary files or increasing storage';

    case ErrorCode.PERMISSION_DENIED:
      return 'Operation not permitted. Check file/directory permissions';

    case ErrorCode.IS_DIRECTORY:
      return `Cannot perform this operation on a directory. Path ${context.path} is a directory`;

    case ErrorCode.NOT_DIRECTORY:
      return `Expected a directory but found a file at ${context.path}`;

    case ErrorCode.RESOURCE_BUSY:
      return 'Resource is currently in use. Wait for the current operation to complete';

    case ErrorCode.READ_ONLY:
      return 'Cannot modify a read-only resource';

    case ErrorCode.SERVICE_NOT_RESPONDING:
      return 'Service is not responding. Check if the service is running and accessible';

    // Generic fallback for other errors
    default:
      return undefined;
  }
}
