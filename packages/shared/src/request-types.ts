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
  env?: Record<string, string | undefined>;
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
  env?: Record<string, string | undefined>;
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
  /** Byte offset to start reading from (for chunked reads) */
  offset?: number;
  /** Number of bytes to read (for chunked reads) */
  length?: number;
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
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * Request to delete a session
 */
export interface SessionDeleteRequest {
  sessionId: string;
}

/**
 * Request to create a backup archive from a directory.
 * The container creates a squashfs archive at archivePath.
 * The DO then reads it and uploads to R2.
 */
export interface CreateBackupRequest {
  /** Directory to back up */
  dir: string;
  /** Path where the container should write the archive */
  archivePath: string;
  sessionId?: string;
}

/**
 * Response from the container after creating a backup archive
 */
export interface CreateBackupResponse {
  success: boolean;
  /** Size of the archive in bytes */
  sizeBytes: number;
  /** Path to the archive file in the container */
  archivePath: string;
}

/**
 * Request to restore a backup from an archive file.
 * The DO writes the archive to archivePath first, then tells the container to extract it.
 */
export interface RestoreBackupRequest {
  /** Directory to restore into */
  dir: string;
  /** Path to the archive file in the container */
  archivePath: string;
  sessionId?: string;
}

/**
 * Response from the container after restoring a backup
 */
export interface RestoreBackupResponse {
  success: boolean;
  /** Directory that was restored */
  dir: string;
}
