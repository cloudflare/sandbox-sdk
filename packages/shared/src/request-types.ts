import type { BackupCompressionOptions } from './types.js';

/**
 * Request types for API calls to the container
 * Single source of truth for the contract between SDK clients and container handlers
 */

/**
 * Request to read a file
 */
export interface ReadFileRequest {
  path: string;
  encoding?: string;
}

/**
 * Request to write a file
 */
export interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: string;
}

/**
 * Request to delete a file
 */
export interface DeleteFileRequest {
  path: string;
}

/**
 * Request to rename a file
 */
export interface RenameFileRequest {
  oldPath: string;
  newPath: string;
}

/**
 * Request to move a file
 */
export interface MoveFileRequest {
  sourcePath: string;
  destinationPath: string;
}

/**
 * Request to create a directory
 */
export interface MkdirRequest {
  path: string;
  recursive?: boolean;
}

/**
 * Request to check if a file or directory exists
 */
export interface FileExistsRequest {
  path: string;
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
  /** Respect git ignore rules when the directory is inside a git repository */
  gitignore?: boolean;
  /** Glob patterns to exclude from the backup */
  excludes?: string[];
  compression?: BackupCompressionOptions;
}

/**
 * A single part to upload in a multipart upload.
 * The container reads the byte range from the local archive and PUTs it
 * to the presigned URL.
 */
export interface UploadPart {
  partNumber: number;
  /** Presigned PUT URL for this part */
  url: string;
  /** Byte offset within the archive file */
  offset: number;
  /** Number of bytes in this part */
  size: number;
}

/**
 * Request to upload parts of a backup archive directly from the container to R2.
 * Used for parallel multipart upload of large archives.
 */
export interface UploadPartsRequest {
  /** Path to the archive file in the container */
  archivePath: string;
  /** Parts to upload in parallel */
  parts: UploadPart[];
}

/**
 * Result for a single uploaded part (ETag returned by R2).
 */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * Response after the container has uploaded all parts.
 */
export interface UploadPartsResponse {
  success: boolean;
  parts: UploadedPart[];
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
}

/**
 * Response from the container after restoring a backup
 */
export interface RestoreBackupResponse {
  success: boolean;
  /** Directory that was restored */
  dir: string;
}
