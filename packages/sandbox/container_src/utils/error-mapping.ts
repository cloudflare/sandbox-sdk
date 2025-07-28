/**
 * Utility functions for mapping system errors to structured error responses
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

export interface ContainerErrorResponse {
  error: string;
  code: string;
  operation: SandboxOperationType;
  httpStatus: number;
  details?: string;
  path?: string;
}

/**
 * Map filesystem errors to structured error responses
 */
export function mapFileSystemError(error: any, operation: SandboxOperationType, path: string): ContainerErrorResponse {
  const errorCode = error.code;
  const errorMessage = error.message || 'Unknown error';

  switch (errorCode) {
    case 'ENOENT':
      return {
        error: `File not found: ${path}`,
        code: 'FILE_NOT_FOUND',
        operation,
        httpStatus: 404,
        details: `The file or directory at "${path}" does not exist`,
        path
      };

    case 'EACCES':
      return {
        error: `Permission denied: ${path}`,
        code: 'PERMISSION_DENIED',
        operation,
        httpStatus: 403,
        details: `Insufficient permissions to ${operation.toLowerCase()} "${path}"`,
        path
      };

    case 'EISDIR':
      return {
        error: `Path is a directory: ${path}`,
        code: 'IS_DIRECTORY',
        operation,
        httpStatus: 400,
        details: `Expected a file but "${path}" is a directory`,
        path
      };

    case 'ENOTDIR':
      return {
        error: `Path is not a directory: ${path}`,
        code: 'NOT_DIRECTORY',
        operation,
        httpStatus: 400,
        details: `Expected a directory but "${path}" is a file`,
        path
      };

    case 'EEXIST':
      return {
        error: `File already exists: ${path}`,
        code: 'FILE_EXISTS',
        operation,
        httpStatus: 409,
        details: `Cannot ${operation.toLowerCase()} because "${path}" already exists`,
        path
      };

    case 'ENOSPC':
      return {
        error: `No space left on device`,
        code: 'NO_SPACE',
        operation,
        httpStatus: 507,
        details: `Insufficient disk space to complete ${operation.toLowerCase()}`,
        path
      };

    case 'EMFILE':
    case 'ENFILE':
      return {
        error: `Too many open files`,
        code: 'TOO_MANY_FILES',
        operation,
        httpStatus: 429,
        details: `System limit reached for open files during ${operation.toLowerCase()}`,
        path
      };

    case 'EBUSY':
      return {
        error: `Resource busy: ${path}`,
        code: 'RESOURCE_BUSY',
        operation,
        httpStatus: 423,
        details: `Cannot ${operation.toLowerCase()} "${path}" because it is in use`,
        path
      };

    case 'EROFS':
      return {
        error: `Read-only file system: ${path}`,
        code: 'READ_ONLY',
        operation,
        httpStatus: 403,
        details: `Cannot ${operation.toLowerCase()} "${path}" on read-only file system`,
        path
      };

    case 'ENAMETOOLONG':
      return {
        error: `File name too long: ${path}`,
        code: 'NAME_TOO_LONG',
        operation,
        httpStatus: 400,
        details: `File path "${path}" exceeds maximum length`,
        path
      };

    case 'ELOOP':
      return {
        error: `Too many symbolic links: ${path}`,
        code: 'TOO_MANY_LINKS',
        operation,
        httpStatus: 400,
        details: `Symbolic link loop detected in path "${path}"`,
        path
      };

    default:
      return {
        error: `${operation} failed: ${errorMessage}`,
        code: 'FILESYSTEM_ERROR',
        operation,
        httpStatus: 500,
        details: `Unexpected filesystem error: ${errorMessage}`,
        path
      };
  }
}

/**
 * Map command execution errors to structured error responses
 */
export function mapCommandError(error: any, operation: SandboxOperationType, command: string): ContainerErrorResponse {
  const errorMessage = error.message || 'Unknown error';

  if (error.code === 'ENOENT') {
    return {
      error: `Command not found: ${command}`,
      code: 'COMMAND_NOT_FOUND',
      operation,
      httpStatus: 404,
      details: `The command "${command}" was not found in the system PATH`
    };
  }

  if (error.code === 'EACCES') {
    return {
      error: `Permission denied for command: ${command}`,
      code: 'COMMAND_PERMISSION_DENIED',
      operation,
      httpStatus: 403,
      details: `Insufficient permissions to execute "${command}"`
    };
  }

  return {
    error: `Command execution failed: ${errorMessage}`,
    code: 'COMMAND_EXECUTION_ERROR',
    operation,
    httpStatus: 500,
    details: `Failed to execute "${command}": ${errorMessage}`
  };
}

/**
 * Map process management errors to structured error responses
 */
export function mapProcessError(error: any, operation: SandboxOperationType, processId?: string): ContainerErrorResponse {
  const errorMessage = error.message || 'Unknown error';

  if (error.code === 'ESRCH') {
    return {
      error: processId ? `Process not found: ${processId}` : 'Process not found',
      code: 'PROCESS_NOT_FOUND',
      operation,
      httpStatus: 404,
      details: processId ? `Process with ID "${processId}" does not exist` : 'The specified process does not exist'
    };
  }

  if (error.code === 'EPERM') {
    return {
      error: processId ? `Permission denied for process: ${processId}` : 'Permission denied for process operation',
      code: 'PROCESS_PERMISSION_DENIED',
      operation,
      httpStatus: 403,
      details: processId ? `Insufficient permissions to manage process "${processId}"` : 'Insufficient permissions for process operation'
    };
  }

  return {
    error: `Process ${operation.toLowerCase()} failed: ${errorMessage}`,
    code: 'PROCESS_ERROR',
    operation,
    httpStatus: 500,
    details: `Failed to ${operation.toLowerCase()}: ${errorMessage}`
  };
}

/**
 * Map port management errors to structured error responses
 */
export function mapPortError(error: any, operation: SandboxOperationType, port?: number): ContainerErrorResponse {
  const errorMessage = error.message || 'Unknown error';
  const portStr = port ? port.toString() : 'unknown';

  // Handle network/connectivity errors
  if (error.code === 'ECONNREFUSED') {
    return {
      error: `Service on port ${portStr} is not responding`,
      code: 'SERVICE_NOT_RESPONDING',
      operation,
      httpStatus: 502,
      details: `Failed to connect to service on port ${portStr}`
    };
  }

  if (error.code === 'EADDRINUSE') {
    return {
      error: `Port ${portStr} is already in use`,
      code: 'PORT_IN_USE',
      operation,
      httpStatus: 409,
      details: `Cannot bind to port ${portStr} because it is already in use`
    };
  }

  return {
    error: `Port ${operation.toLowerCase()} failed: ${errorMessage}`,
    code: 'PORT_OPERATION_ERROR',
    operation,
    httpStatus: 500,
    details: `Failed to ${operation.toLowerCase()} port ${portStr}: ${errorMessage}`
  };
}

/**
 * Map git operation errors to structured error responses
 */
export function mapGitError(error: any, operation: SandboxOperationType, repoUrl?: string, branch?: string): ContainerErrorResponse {
  const errorMessage = error.message || 'Unknown error';
  const stderr = error.stderr || '';

  // Check for authentication failures
  if (stderr.includes('Authentication failed') || stderr.includes('Permission denied') || stderr.includes('403')) {
    return {
      error: `Git authentication failed: ${repoUrl || 'repository'}`,
      code: 'GIT_AUTH_FAILED',
      operation,
      httpStatus: 401,
      details: `Authentication failed for repository: ${repoUrl || 'unknown'}`
    };
  }

  // Check for repository not found
  if (stderr.includes('Repository not found') || stderr.includes('404') || stderr.includes('does not exist')) {
    return {
      error: `Git repository not found: ${repoUrl || 'repository'}`,
      code: 'GIT_REPOSITORY_NOT_FOUND',
      operation,
      httpStatus: 404,
      details: `Repository ${repoUrl || 'unknown'} does not exist or is not accessible`
    };
  }

  // Check for branch not found
  if (stderr.includes('Remote branch') && stderr.includes('not found') && branch) {
    return {
      error: `Git branch not found: ${branch}`,
      code: 'GIT_BRANCH_NOT_FOUND',
      operation,
      httpStatus: 404,
      details: `Branch "${branch}" does not exist in repository ${repoUrl || 'unknown'}`
    };
  }

  // Check for network issues
  if (stderr.includes('Could not resolve host') || stderr.includes('Connection refused') || stderr.includes('timeout')) {
    return {
      error: `Git network error: ${repoUrl || 'repository'}`,
      code: 'GIT_NETWORK_ERROR',
      operation,
      httpStatus: 502,
      details: `Network connectivity issue when accessing ${repoUrl || 'repository'}`
    };
  }

  // Generic git failure
  if (operation.toLowerCase().includes('clone')) {
    return {
      error: `Git clone failed: ${repoUrl || 'repository'}`,
      code: 'GIT_CLONE_FAILED',
      operation,
      httpStatus: 500,
      details: `Failed to clone repository: ${errorMessage}`
    };
  }

  if (operation.toLowerCase().includes('checkout')) {
    return {
      error: `Git checkout failed: ${branch || 'branch'}`,
      code: 'GIT_CHECKOUT_FAILED',
      operation,
      httpStatus: 500,
      details: `Failed to checkout branch: ${errorMessage}`
    };
  }

  return {
    error: `Git ${operation.toLowerCase()} failed: ${errorMessage}`,
    code: 'GIT_OPERATION_FAILED',
    operation,
    httpStatus: 500,
    details: `Git operation failed: ${errorMessage}`
  };
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  errorData: ContainerErrorResponse,
  corsHeaders: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({
      error: errorData.error,
      code: errorData.code,
      operation: errorData.operation,
      details: errorData.details,
      path: errorData.path,
      timestamp: new Date().toISOString()
    }),
    {
      status: errorData.httpStatus,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    }
  );
}