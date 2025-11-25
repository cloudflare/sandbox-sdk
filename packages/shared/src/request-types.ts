/**
 * Request types for API calls to the container
 * These types enforce the contract between the Durable Object client and container handlers
 *
 * IMPORTANT: These types must match the Zod schemas in:
 * @repo/sandbox-container/src/validation/schemas.ts
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
  env?: Record<string, string>;
  cwd?: string;
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
}

/**
 * Request to clone a Git repository
 */
export interface GitCheckoutRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
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
