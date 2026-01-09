/**
 * Request types for API calls to the container
 * Single source of truth for the contract between SDK clients and container handlers
 */

/**
 * Request to execute a command
 */
export interface ExecuteRequest {
  command: string;
  sessionId?: string;
  background?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Request to start a background process
 * Uses flat structure consistent with other endpoints
 */
export interface StartProcessRequest {
  command: string;
  sessionId?: string;
  processId?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  encoding?: string;
  autoCleanup?: boolean;
}

/**
 * Request to read a file
 */
export interface ReadFileRequest {
  path: string;
  encoding?: string;
  sessionId?: string;
}

/**
 * Request to write a file
 */
export interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: string;
  sessionId?: string;
}

/**
 * Request to delete a file
 */
export interface DeleteFileRequest {
  path: string;
  sessionId?: string;
}

/**
 * Request to rename a file
 */
export interface RenameFileRequest {
  oldPath: string;
  newPath: string;
  sessionId?: string;
}

/**
 * Request to move a file
 */
export interface MoveFileRequest {
  sourcePath: string;
  destinationPath: string;
  sessionId?: string;
}

/**
 * Request to create a directory
 */
export interface MkdirRequest {
  path: string;
  recursive?: boolean;
  sessionId?: string;
}

/**
 * Request to check if a file or directory exists
 */
export interface FileExistsRequest {
  path: string;
  sessionId?: string;
}

/**
 * Request to expose a port
 */
export interface ExposePortRequest {
  port: number;
  name?: string;
  /**
   * Custom token for the preview URL (optional)
   * If not provided, a random 16-character token will be generated
   * Must be 1-16 characters, containing only lowercase letters, numbers, hyphens, and underscores
   */
  token?: string;
}

/**
 * Request to clone a Git repository
 */
export interface GitCheckoutRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  sessionId?: string;
  /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
  depth?: number;
}

/**
 * Request to list files in a directory
 */
export interface ListFilesRequest {
  path: string;
  options?: {
    recursive?: boolean;
    includeHidden?: boolean;
  };
  sessionId?: string;
}

/**
 * Request to create a session
 */
export interface SessionCreateRequest {
  id?: string;
  name?: string;
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Request to delete a session
 */
export interface SessionDeleteRequest {
  sessionId: string;
}
