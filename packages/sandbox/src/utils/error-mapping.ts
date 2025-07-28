/**
 * Client-side error mapping utilities
 */

import {
  SandboxError,
  FileSystemError,
  FileNotFoundError,
  PermissionDeniedError,
  FileExistsError,
  CommandError,
  CommandNotFoundError,
  ProcessError,
  ProcessNotFoundError,
  PortError,
  PortAlreadyExposedError,
  PortNotExposedError,
  InvalidPortError,
  ServiceNotRespondingError,
  PortInUseError,
  GitError,
  GitRepositoryNotFoundError,
  GitAuthenticationError,
  GitBranchNotFoundError,
  GitNetworkError,
  GitCloneError,
  GitCheckoutError,
  InvalidGitUrlError,
  SandboxOperation,
  type SandboxOperationType
} from '../errors';
import type { ErrorResponse } from '../clients/types';

/**
 * Map container error responses to specific error classes
 */
export function mapContainerError(errorResponse: ErrorResponse & { code?: string; operation?: SandboxOperationType; path?: string }): Error {
  const { error: message, code, operation, details, path } = errorResponse;

  if (!code) {
    return new SandboxError(message, undefined, operation as SandboxOperationType, details);
  }

  // File system errors
  switch (code) {
    case 'FILE_NOT_FOUND':
      return new FileNotFoundError(path || 'unknown', operation || SandboxOperation.FILE_READ);

    case 'PERMISSION_DENIED':
      return new PermissionDeniedError(path || 'unknown', operation || SandboxOperation.FILE_READ);

    case 'FILE_EXISTS':
      return new FileExistsError(path || 'unknown', operation || SandboxOperation.FILE_WRITE);

    case 'IS_DIRECTORY':
    case 'NOT_DIRECTORY':
    case 'NO_SPACE':
    case 'TOO_MANY_FILES':
    case 'RESOURCE_BUSY':
    case 'READ_ONLY':
    case 'NAME_TOO_LONG':
    case 'TOO_MANY_LINKS':
    case 'FILESYSTEM_ERROR':
      return new FileSystemError(message, path || 'unknown', code, operation || SandboxOperation.FILE_READ, details);

    // Command errors
    case 'COMMAND_NOT_FOUND':
      return new CommandNotFoundError(extractCommandFromMessage(message));

    case 'COMMAND_PERMISSION_DENIED':
    case 'COMMAND_EXECUTION_ERROR':
      return new CommandError(message, extractCommandFromMessage(message), code, details);

    // Process errors
    case 'PROCESS_NOT_FOUND':
      return new ProcessNotFoundError(extractProcessIdFromMessage(message));

    case 'PROCESS_PERMISSION_DENIED':
    case 'PROCESS_ERROR':
      return new ProcessError(message, extractProcessIdFromMessage(message), code, operation as SandboxOperationType, details);

    // Port errors
    case 'PORT_ALREADY_EXPOSED':
      return new PortAlreadyExposedError(extractPortFromMessage(message));

    case 'PORT_NOT_EXPOSED':
      return new PortNotExposedError(extractPortFromMessage(message), operation || SandboxOperation.PORT_UNEXPOSE);

    case 'INVALID_PORT_NUMBER':
      return new InvalidPortError(extractPortFromMessage(message), details || 'Invalid port', operation || SandboxOperation.PORT_EXPOSE);

    case 'SERVICE_NOT_RESPONDING':
      return new ServiceNotRespondingError(extractPortFromMessage(message));

    case 'PORT_IN_USE':
      return new PortInUseError(extractPortFromMessage(message));

    case 'PORT_OPERATION_ERROR':
      return new PortError(message, extractPortFromMessage(message), code, operation || SandboxOperation.PORT_PROXY, details);

    // Git errors
    case 'GIT_REPOSITORY_NOT_FOUND':
      return new GitRepositoryNotFoundError(extractRepositoryFromMessage(message, details));

    case 'GIT_AUTH_FAILED':
      return new GitAuthenticationError(extractRepositoryFromMessage(message, details));

    case 'GIT_BRANCH_NOT_FOUND':
      return new GitBranchNotFoundError(extractBranchFromMessage(message, details), extractRepositoryFromMessage(message, details));

    case 'GIT_NETWORK_ERROR':
      return new GitNetworkError(extractRepositoryFromMessage(message, details));

    case 'GIT_CLONE_FAILED':
      return new GitCloneError(extractRepositoryFromMessage(message, details), details);

    case 'GIT_CHECKOUT_FAILED':
      return new GitCheckoutError(extractBranchFromMessage(message, details), extractRepositoryFromMessage(message, details), details);

    case 'INVALID_GIT_URL':
      return new InvalidGitUrlError(extractRepositoryFromMessage(message, details));

    case 'GIT_OPERATION_FAILED':
      return new GitError(message, extractRepositoryFromMessage(message, details), extractBranchFromMessage(message, details), code, operation as SandboxOperationType, details);

    default:
      return new SandboxError(message, code, operation as SandboxOperationType, details);
  }
}

/**
 * Extract command name from error message
 */
function extractCommandFromMessage(message: string): string {
  const match = message.match(/Command (?:not found|execution failed): (.+?)(?:\s|$)/);
  return match?.[1] || 'unknown';
}

/**
 * Extract process ID from error message
 */
function extractProcessIdFromMessage(message: string): string {
  const match = message.match(/Process (?:not found): (.+?)(?:\s|$)/);
  return match?.[1] || 'unknown';
}

/**
 * Extract port number from error message
 */
function extractPortFromMessage(message: string): number {
  const match = message.match(/(?:port|Port) (?:already exposed|not exposed|in use): (\d+)|(?:Service on port) (\d+)|(?:Invalid port.*?): (\d+)/);
  const portStr = match?.[1] || match?.[2] || match?.[3];
  return portStr ? parseInt(portStr, 10) : 0;
}

/**
 * Extract repository URL from error message or details
 */
function extractRepositoryFromMessage(message: string, details?: string): string {
  // Try details first (more reliable)
  if (details && (details.includes('http') || details.includes('git@'))) {
    return details;
  }

  // Try to extract from message
  const match = message.match(/(?:repository|Repository|URL).*?:?\s*([^\s]+)/);
  return match?.[1] || 'unknown';
}

/**
 * Extract branch name from error message or details
 */
function extractBranchFromMessage(message: string, details?: string): string {
  // Try details first
  if (details && details.includes('Branch')) {
    const match = details.match(/Branch "([^"]+)"/);
    if (match) return match[1];
  }

  // Try to extract from message
  const match = message.match(/(?:branch|Branch).*?:?\s*([^\s]+)/);
  return match?.[1] || 'unknown';
}

/**
 * Check if an error response indicates a specific error type
 */
export function isFileNotFoundError(errorResponse: ErrorResponse & { code?: string }): boolean {
  return errorResponse.code === 'FILE_NOT_FOUND';
}

export function isPermissionError(errorResponse: ErrorResponse & { code?: string }): boolean {
  return errorResponse.code === 'PERMISSION_DENIED' || errorResponse.code === 'COMMAND_PERMISSION_DENIED';
}

export function isFileSystemError(errorResponse: ErrorResponse & { code?: string }): boolean {
  const fileSystemCodes = [
    'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'FILE_EXISTS', 'IS_DIRECTORY',
    'NOT_DIRECTORY', 'NO_SPACE', 'TOO_MANY_FILES', 'RESOURCE_BUSY',
    'READ_ONLY', 'NAME_TOO_LONG', 'TOO_MANY_LINKS', 'FILESYSTEM_ERROR'
  ];
  return fileSystemCodes.includes(errorResponse.code || '');
}

export function isCommandError(errorResponse: ErrorResponse & { code?: string }): boolean {
  const commandCodes = ['COMMAND_NOT_FOUND', 'COMMAND_PERMISSION_DENIED', 'COMMAND_EXECUTION_ERROR'];
  return commandCodes.includes(errorResponse.code || '');
}

export function isProcessError(errorResponse: ErrorResponse & { code?: string }): boolean {
  const processCodes = ['PROCESS_NOT_FOUND', 'PROCESS_PERMISSION_DENIED', 'PROCESS_ERROR'];
  return processCodes.includes(errorResponse.code || '');
}

export function isPortError(errorResponse: ErrorResponse & { code?: string }): boolean {
  const portCodes = [
    'PORT_ALREADY_EXPOSED', 'PORT_NOT_EXPOSED', 'INVALID_PORT_NUMBER',
    'SERVICE_NOT_RESPONDING', 'PORT_IN_USE', 'PORT_OPERATION_ERROR'
  ];
  return portCodes.includes(errorResponse.code || '');
}

export function isGitError(errorResponse: ErrorResponse & { code?: string }): boolean {
  const gitCodes = [
    'GIT_REPOSITORY_NOT_FOUND', 'GIT_AUTH_FAILED', 'GIT_BRANCH_NOT_FOUND',
    'GIT_NETWORK_ERROR', 'GIT_CLONE_FAILED', 'GIT_CHECKOUT_FAILED',
    'INVALID_GIT_URL', 'GIT_OPERATION_FAILED'
  ];
  return gitCodes.includes(errorResponse.code || '');
}