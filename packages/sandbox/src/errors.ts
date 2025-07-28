/**
 * Error classes for the Cloudflare Sandbox SDK
 * These are internal errors thrown by the SDK implementation
 */

/**
 * Strongly-typed operations for better type safety and IntelliSense
 */
export const SandboxOperation = {
  // File Operations
  FILE_READ: 'Read File',
  FILE_WRITE: 'Write File',
  FILE_DELETE: 'Delete File',
  FILE_MOVE: 'Move File',
  FILE_RENAME: 'Rename File',
  DIRECTORY_CREATE: 'Create Directory',

  // Command Operations
  COMMAND_EXECUTE: 'Execute Command',
  COMMAND_STREAM: 'Stream Command',

  // Process Operations
  PROCESS_START: 'Start Process',
  PROCESS_KILL: 'Kill Process',
  PROCESS_LIST: 'List Processes',
  PROCESS_GET: 'Get Process',
  PROCESS_LOGS: 'Get Process Logs',
  PROCESS_STREAM_LOGS: 'Stream Process Logs',

  // Port Operations
  PORT_EXPOSE: 'Expose Port',
  PORT_UNEXPOSE: 'Unexpose Port',
  PORT_LIST: 'List Exposed Ports',
  PORT_PROXY: 'Proxy Request',

  // Git Operations
  GIT_CLONE: 'Git Clone',
  GIT_CHECKOUT: 'Git Checkout',
  GIT_OPERATION: 'Git Operation'
} as const;

export type SandboxOperationType = typeof SandboxOperation[keyof typeof SandboxOperation];

export class SandboxError extends Error {
  constructor(
    message: string,
    public code?: string,
    public operation?: SandboxOperationType,
    public details?: string,
    public httpStatus?: number
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class ProcessNotFoundError extends SandboxError {
  constructor(processId: string) {
    super(`Process not found: ${processId}`, 'PROCESS_NOT_FOUND', SandboxOperation.PROCESS_GET);
    this.name = 'ProcessNotFoundError';
  }
}

export class FileSystemError extends SandboxError {
  constructor(
    message: string,
    public path: string,
    code: string,
    operation: SandboxOperationType,
    details?: string,
    httpStatus?: number
  ) {
    super(message, code, operation, details, httpStatus);
    this.name = 'FileSystemError';
  }
}

export class FileNotFoundError extends FileSystemError {
  constructor(path: string, operation: SandboxOperationType = SandboxOperation.FILE_READ) {
    super(
      `File not found: ${path}`,
      path,
      'FILE_NOT_FOUND',
      operation,
      `The file or directory at "${path}" does not exist`,
      404
    );
    this.name = 'FileNotFoundError';
  }
}

export class PermissionDeniedError extends FileSystemError {
  constructor(path: string, operation: SandboxOperationType = SandboxOperation.FILE_READ) {
    super(
      `Permission denied: ${path}`,
      path,
      'PERMISSION_DENIED',
      operation,
      `Insufficient permissions to access "${path}"`,
      403
    );
    this.name = 'PermissionDeniedError';
  }
}

export class FileExistsError extends FileSystemError {
  constructor(path: string, operation: SandboxOperationType = SandboxOperation.FILE_WRITE) {
    super(
      `File already exists: ${path}`,
      path,
      'FILE_EXISTS',
      operation,
      `Cannot complete operation because "${path}" already exists`,
      409
    );
    this.name = 'FileExistsError';
  }
}

export class CommandError extends SandboxError {
  constructor(
    message: string,
    public command: string,
    code: string,
    details?: string,
    httpStatus?: number
  ) {
    super(message, code, SandboxOperation.COMMAND_EXECUTE, details, httpStatus);
    this.name = 'CommandError';
  }
}

export class CommandNotFoundError extends CommandError {
  constructor(command: string) {
    super(
      `Command not found: ${command}`,
      command,
      'COMMAND_NOT_FOUND',
      `The command "${command}" was not found in the system PATH`,
      404
    );
    this.name = 'CommandNotFoundError';
  }
}

export class ProcessError extends SandboxError {
  constructor(
    message: string,
    public processId?: string,
    code?: string,
    operation?: SandboxOperationType,
    details?: string,
    httpStatus?: number
  ) {
    super(message, code, operation || SandboxOperation.PROCESS_GET, details, httpStatus);
    this.name = 'ProcessError';
  }
}

export class PortError extends SandboxError {
  constructor(
    message: string,
    public port: number,
    code: string,
    operation: SandboxOperationType,
    details?: string,
    httpStatus?: number
  ) {
    super(message, code, operation, details, httpStatus);
    this.name = 'PortError';
  }
}

export class PortAlreadyExposedError extends PortError {
  constructor(port: number) {
    super(
      `Port already exposed: ${port}`,
      port,
      'PORT_ALREADY_EXPOSED',
      SandboxOperation.PORT_EXPOSE,
      `Port ${port} is already exposed and cannot be exposed again`,
      409
    );
    this.name = 'PortAlreadyExposedError';
  }
}

export class PortNotExposedError extends PortError {
  constructor(port: number, operation: SandboxOperationType = SandboxOperation.PORT_UNEXPOSE) {
    super(
      `Port not exposed: ${port}`,
      port,
      'PORT_NOT_EXPOSED',
      operation,
      `Port ${port} is not currently exposed`,
      404
    );
    this.name = 'PortNotExposedError';
  }
}

export class InvalidPortError extends PortError {
  constructor(port: number, reason: string, operation: SandboxOperationType = SandboxOperation.PORT_EXPOSE) {
    super(
      `Invalid port: ${port}`,
      port,
      'INVALID_PORT_NUMBER',
      operation,
      reason,
      400
    );
    this.name = 'InvalidPortError';
  }
}

export class ServiceNotRespondingError extends PortError {
  constructor(port: number) {
    super(
      `Service on port ${port} is not responding`,
      port,
      'SERVICE_NOT_RESPONDING',
      SandboxOperation.PORT_PROXY,
      `Failed to connect to service on port ${port}`,
      502
    );
    this.name = 'ServiceNotRespondingError';
  }
}

export class PortInUseError extends PortError {
  constructor(port: number) {
    super(
      `Port in use: ${port}`,
      port,
      'PORT_IN_USE',
      SandboxOperation.PORT_EXPOSE,
      `Port ${port} is already in use by another service`,
      409
    );
    this.name = 'PortInUseError';
  }
}

export class GitError extends SandboxError {
  constructor(
    message: string,
    public repository?: string,
    public branch?: string,
    code?: string,
    operation?: SandboxOperationType,
    details?: string,
    httpStatus?: number
  ) {
    super(message, code, operation || SandboxOperation.GIT_OPERATION, details, httpStatus);
    this.name = 'GitError';
  }
}

export class GitRepositoryNotFoundError extends GitError {
  constructor(repository: string) {
    super(
      `Git repository not found: ${repository}`,
      repository,
      undefined,
      'GIT_REPOSITORY_NOT_FOUND',
      SandboxOperation.GIT_CHECKOUT,
      `Repository ${repository} does not exist or is not accessible`,
      404
    );
    this.name = 'GitRepositoryNotFoundError';
  }
}

export class GitAuthenticationError extends GitError {
  constructor(repository: string) {
    super(
      `Git authentication failed: ${repository}`,
      repository,
      undefined,
      'GIT_AUTH_FAILED',
      SandboxOperation.GIT_CHECKOUT,
      `Authentication failed for repository ${repository}`,
      401
    );
    this.name = 'GitAuthenticationError';
  }
}

export class GitBranchNotFoundError extends GitError {
  constructor(branch: string, repository?: string) {
    super(
      `Git branch not found: ${branch}`,
      repository,
      branch,
      'GIT_BRANCH_NOT_FOUND',
      SandboxOperation.GIT_CHECKOUT,
      `Branch "${branch}" does not exist in repository`,
      404
    );
    this.name = 'GitBranchNotFoundError';
  }
}

export class GitNetworkError extends GitError {
  constructor(repository: string) {
    super(
      `Git network error: ${repository}`,
      repository,
      undefined,
      'GIT_NETWORK_ERROR',
      SandboxOperation.GIT_OPERATION,
      `Network connectivity issue when accessing ${repository}`,
      502
    );
    this.name = 'GitNetworkError';
  }
}

export class GitCloneError extends GitError {
  constructor(repository: string, reason?: string) {
    super(
      `Git clone failed: ${repository}`,
      repository,
      undefined,
      'GIT_CLONE_FAILED',
      SandboxOperation.GIT_CLONE,
      reason || `Failed to clone repository ${repository}`,
      500
    );
    this.name = 'GitCloneError';
  }
}

export class GitCheckoutError extends GitError {
  constructor(branch: string, repository?: string, reason?: string) {
    super(
      `Git checkout failed: ${branch}`,
      repository,
      branch,
      'GIT_CHECKOUT_FAILED',
      SandboxOperation.GIT_CHECKOUT,
      reason || `Failed to checkout branch ${branch}`,
      500
    );
    this.name = 'GitCheckoutError';
  }
}

export class InvalidGitUrlError extends GitError {
  constructor(url: string) {
    super(
      `Invalid Git URL: ${url}`,
      url,
      undefined,
      'INVALID_GIT_URL',
      SandboxOperation.GIT_OPERATION,
      `Git URL "${url}" does not match expected format`,
      400
    );
    this.name = 'InvalidGitUrlError';
  }
}