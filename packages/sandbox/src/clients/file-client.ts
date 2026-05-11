import type {
  DeleteFileResult,
  FileEncoding,
  FileExistsResult,
  ListFilesOptions,
  ListFilesResult,
  MkdirResult,
  MoveFileResult,
  ReadFileResult,
  ReadFileStreamResult,
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
    const data = {
      path,
      sessionId,
      recursive: options?.recursive ?? false
    };

    const response = await this.post<MkdirResult>('/api/mkdir', data);

    return response;
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
    const data = {
      path,
      content,
      sessionId,
      encoding: options?.encoding
    };

    const response = await this.post<WriteFileResult>('/api/write', data);

    return response;
  }

  /**
   * Read content from a file.
   *
   * @param path - File path to read from
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (encoding)
   *
   * When `encoding` is `'none'`, returns a `ReadFileStreamResult` whose
   * `content` is a raw `ReadableStream<Uint8Array>`. This variant only works
   * on the `rpc` transport; HTTP and WebSocket transports throw at runtime.
   */
  async readFile(
    path: string,
    sessionId: string,
    options: { encoding: 'none' }
  ): Promise<ReadFileStreamResult>;
  async readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: Exclude<FileEncoding, 'none'> }
  ): Promise<ReadFileResult>;
  async readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: FileEncoding }
  ): Promise<ReadFileResult | ReadFileStreamResult> {
    if (options?.encoding === 'none') {
      throw new Error(
        "readFile with encoding: 'none' requires the rpc transport. Set SANDBOX_TRANSPORT=rpc."
      );
    }
    const data = {
      path,
      sessionId,
      encoding: options?.encoding
    };

    const response = await this.post<ReadFileResult>('/api/read', data);

    return response;
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
    const data = {
      path,
      sessionId
    };

    // Use doStreamFetch which handles both WebSocket and HTTP streaming
    const stream = await this.doStreamFetch('/api/read/stream', data);
    return stream;
  }

  /**
   * Delete a file
   * @param path - File path to delete
   * @param sessionId - The session ID for this operation
   */
  async deleteFile(path: string, sessionId: string): Promise<DeleteFileResult> {
    const data = { path, sessionId };

    const response = await this.post<DeleteFileResult>('/api/delete', data);

    return response;
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
    const data = { oldPath: path, newPath, sessionId };

    const response = await this.post<RenameFileResult>('/api/rename', data);

    return response;
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
    const data = { sourcePath: path, destinationPath: newPath, sessionId };

    const response = await this.post<MoveFileResult>('/api/move', data);

    return response;
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
    const data = {
      path,
      sessionId,
      options: options || {}
    };

    const response = await this.post<ListFilesResult>('/api/list-files', data);

    return response;
  }

  /**
   * Check if a file or directory exists
   * @param path - Path to check
   * @param sessionId - The session ID for this operation
   */
  async exists(path: string, sessionId: string): Promise<FileExistsResult> {
    const data = {
      path,
      sessionId
    };

    const response = await this.post<FileExistsResult>('/api/exists', data);

    return response;
  }

  /**
   * Write a file via a raw binary stream over the RPC transport.
   * Throws on HTTP and WebSocket transports — use writeFile() with a string instead.
   */
  writeFileStream(
    _path: string,
    _content: ReadableStream<Uint8Array>,
    _sessionId: string
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }> {
    throw new Error(
      'writeFileStream requires the rpc transport. Set SANDBOX_TRANSPORT=rpc.'
    );
  }
}
