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
 * Decode a base64 string to bytes with a helpful error message on failure.
 */
export function decodeBase64(content: string): Uint8Array {
  try {
    return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(
      'writeFile: content is not valid base64. ' +
        'Decode the base64 string before calling writeFile, or pass a ReadableStream instead.'
    );
  }
}

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
  content: string | ReadableStream<Uint8Array>;
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
        recursive: options?.recursive ?? false
      };

      const response = await this.post<MkdirResult>('/api/mkdir', data);

      this.logSuccess(
        'Directory created',
        `${path} (recursive: ${data.recursive})`
      );
      return response;
    } catch (error) {
      this.logError('mkdir', error);
      throw error;
    }
  }

  /**
   * Write content to a file
   * @param path - File path to write to
   * @param content - Content to write (string or binary stream)
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (encoding)
   */
  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<WriteFileResult> {
    try {
      let stream: ReadableStream<Uint8Array>;

      if (content instanceof ReadableStream) {
        stream = content;
      } else {
        let bytes: Uint8Array;
        if (options?.encoding === 'base64') {
          bytes = decodeBase64(content);
        } else {
          bytes = new TextEncoder().encode(content);
        }
        stream = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          }
        });
      }

      const url = new URL('/api/write', 'http://placeholder');
      url.searchParams.set('path', path);
      url.searchParams.set('sessionId', sessionId);

      await this.transport.waitForContainer();

      // TODO: Refactor the transport layer to support a concept of operations
      // that cannot be streamed over WebSocket (e.g. via a supportsStreamBody()
      // method), so FileClient doesn't need to know about transport internals.
      //
      // File writes always bypass WebSocket transport and go directly over HTTP.
      // Sending a ReadableStream body over WebSocket requires buffering the
      // entire file in memory before encoding it, which defeats the purpose of
      // streaming and breaks large file uploads.
      const writePath = `/api/write?${url.searchParams.toString()}`;
      const fetchOptions: RequestInit = {
        method: 'POST',
        body: stream,
        duplex: 'half'
      } as RequestInit;

      let response: Response;
      if (this.options.stub) {
        const writeUrl = `http://localhost:${this.options.port ?? 3000}${writePath}`;
        response = await this.options.stub.containerFetch(
          writeUrl,
          fetchOptions,
          this.options.port
        );
      } else {
        const baseUrl = this.options.baseUrl ?? 'http://localhost:3000';
        response = await globalThis.fetch(
          `${baseUrl}${writePath}`,
          fetchOptions
        );
      }

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const result = (await response.json()) as WriteFileResult;

      this.logSuccess('File written', path);
      return result;
    } catch (error) {
      this.logError('writeFile', error);
      throw error;
    }
  }

  /**
   * Read a file from the filesystem
   * @param path - File path to read
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
        encoding: options?.encoding
      };

      const response = await this.post<ReadFileResult>('/api/read', data);

      this.logSuccess(
        'File read',
        `${path} (${response.content.length} chars)`
      );
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
        sessionId
      };

      // Use doStreamFetch which handles both WebSocket and HTTP streaming
      const stream = await this.doStreamFetch('/api/read/stream', data);
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
  async deleteFile(path: string, sessionId: string): Promise<DeleteFileResult> {
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
        options: options || {}
      };

      const response = await this.post<ListFilesResult>(
        '/api/list-files',
        data
      );

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
  async exists(path: string, sessionId: string): Promise<FileExistsResult> {
    try {
      const data = {
        path,
        sessionId
      };

      const response = await this.post<FileExistsResult>('/api/exists', data);

      this.logSuccess(
        'Path existence checked',
        `${path} (exists: ${response.exists})`
      );
      return response;
    } catch (error) {
      this.logError('exists', error);
      throw error;
    }
  }
}
