import type {
  DeleteFileResult,
  FileExistsResult,
  ListFilesOptions,
  ListFilesResult,
  MkdirResult,
  MoveFileResult,
  ReadFileResult,
  RenameFileResult,
  WriteFileResult
} from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { HttpClientOptions, SessionRequest } from './types';

/**
 * Request interface for creating directories
 */
export interface MkdirRequest extends SessionRequest {
  path: string;
  recursive?: boolean;
}

/**
 * Request interface for writing files
 */
export interface WriteFileRequest extends SessionRequest {
  path: string;
  content: string;
  encoding?: string;
}

/**
 * Request interface for reading files
 */
export interface ReadFileRequest extends SessionRequest {
  path: string;
  encoding?: string;
}

/**
 * Request interface for file operations (delete, rename, move)
 */
export interface FileOperationRequest extends SessionRequest {
  path: string;
  newPath?: string; // For rename/move operations
}

/**
 * Client for file system operations
 */
export class FileClient extends BaseHttpClient {

  /**
   * Create a directory
   * @param path - Directory path to create
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (recursive)
   */
  async mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ): Promise<MkdirResult> {
    try {
      const data = {
        path,
        sessionId,
        recursive: options?.recursive ?? false,
      };

      const response = await this.post<MkdirResult>('/api/mkdir', data);
      
      this.logSuccess('Directory created', `${path} (recursive: ${data.recursive})`);
      return response;
    } catch (error) {
      this.logError('mkdir', error);
      throw error;
    }
  }

  /**
   * Write content to a file
   * @param path - File path to write to
   * @param content - Content to write
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (encoding)
   */
  async writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<WriteFileResult> {
    try {
      const data = {
        path,
        content,
        sessionId,
        encoding: options?.encoding ?? 'utf8',
      };

      const response = await this.post<WriteFileResult>('/api/write', data);
      
      this.logSuccess('File written', `${path} (${content.length} chars)`);
      return response;
    } catch (error) {
      this.logError('writeFile', error);
      throw error;
    }
  }

  /**
   * Read content from a file
   * @param path - File path to read from
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (encoding)
   */
  async readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<ReadFileResult> {
    try {
      const data = {
        path,
        sessionId,
        encoding: options?.encoding ?? 'utf8',
      };

      const response = await this.post<ReadFileResult>('/api/read', data);

      this.logSuccess('File read', `${path} (${response.content.length} chars)`);
      return response;
    } catch (error) {
      this.logError('readFile', error);
      throw error;
    }
  }

  /**
   * Stream a file using Server-Sent Events
   * Returns a ReadableStream of SSE events containing metadata, chunks, and completion
   * @param path - File path to stream
   * @param sessionId - The session ID for this operation
   */
  async readFileStream(
    path: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const data = {
        path,
        sessionId,
      };

      const response = await this.doFetch('/api/read/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const stream = await this.handleStreamResponse(response);
      this.logSuccess('File stream started', path);
      return stream;
    } catch (error) {
      this.logError('readFileStream', error);
      throw error;
    }
  }

  /**
   * Delete a file
   * @param path - File path to delete
   * @param sessionId - The session ID for this operation
   */
  async deleteFile(
    path: string,
    sessionId: string
  ): Promise<DeleteFileResult> {
    try {
      const data = { path, sessionId };

      const response = await this.post<DeleteFileResult>('/api/delete', data);
      
      this.logSuccess('File deleted', path);
      return response;
    } catch (error) {
      this.logError('deleteFile', error);
      throw error;
    }
  }

  /**
   * Rename a file
   * @param path - Current file path
   * @param newPath - New file path
   * @param sessionId - The session ID for this operation
   */
  async renameFile(
    path: string,
    newPath: string,
    sessionId: string
  ): Promise<RenameFileResult> {
    try {
      const data = { oldPath: path, newPath, sessionId };

      const response = await this.post<RenameFileResult>('/api/rename', data);
      
      this.logSuccess('File renamed', `${path} -> ${newPath}`);
      return response;
    } catch (error) {
      this.logError('renameFile', error);
      throw error;
    }
  }

  /**
   * Move a file
   * @param path - Current file path
   * @param newPath - Destination file path
   * @param sessionId - The session ID for this operation
   */
  async moveFile(
    path: string,
    newPath: string,
    sessionId: string
  ): Promise<MoveFileResult> {
    try {
      const data = { sourcePath: path, destinationPath: newPath, sessionId };

      const response = await this.post<MoveFileResult>('/api/move', data);

      this.logSuccess('File moved', `${path} -> ${newPath}`);
      return response;
    } catch (error) {
      this.logError('moveFile', error);
      throw error;
    }
  }

  /**
   * List files in a directory
   * @param path - Directory path to list
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (recursive, includeHidden)
   */
  async listFiles(
    path: string,
    sessionId: string,
    options?: ListFilesOptions
  ): Promise<ListFilesResult> {
    try {
      const data = {
        path,
        sessionId,
        options: options || {},
      };

      const response = await this.post<ListFilesResult>('/api/list-files', data);

      this.logSuccess('Files listed', `${path} (${response.count} files)`);
      return response;
    } catch (error) {
      this.logError('listFiles', error);
      throw error;
    }
  }

  /**
   * Check if a file or directory exists
   * @param path - Path to check
   * @param sessionId - The session ID for this operation
   */
  async exists(
    path: string,
    sessionId: string
  ): Promise<FileExistsResult> {
    try {
      const data = {
        path,
        sessionId,
      };

      const response = await this.post<FileExistsResult>('/api/exists', data);

      this.logSuccess('Path existence checked', `${path} (exists: ${response.exists})`);
      return response;
    } catch (error) {
      this.logError('exists', error);
      throw error;
    }
  }
}