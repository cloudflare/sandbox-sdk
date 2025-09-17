import { BaseHttpClient } from './base-client';
import type { BaseApiResponse, HttpClientOptions } from './types';

/**
 * Request interface for creating directories
 */
export interface MkdirRequest {
  id: string;  // Session ID
  path: string;
  recursive?: boolean;
}

/**
 * Response interface for directory creation
 */
export interface MkdirResponse extends BaseApiResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  path: string;
  recursive: boolean;
}

/**
 * Request interface for writing files
 */
export interface WriteFileRequest {
  id: string;  // Session ID
  path: string;
  content: string;
  encoding?: string;
}

/**
 * Response interface for file writing
 */
export interface WriteFileResponse extends BaseApiResponse {
  exitCode: number;
  path: string;
}

/**
 * Request interface for reading files
 */
export interface ReadFileRequest {
  id: string;  // Session ID
  path: string;
  encoding?: string;
}

/**
 * Response interface for file reading
 */
export interface ReadFileResponse extends BaseApiResponse {
  exitCode: number;
  path: string;
  content: string;
}

/**
 * Request interface for file operations (delete, rename, move)
 */
export interface FileOperationRequest {
  id: string;  // Session ID
  path: string;
  newPath?: string; // For rename/move operations
}

/**
 * Response interface for file operations
 */
export interface FileOperationResponse extends BaseApiResponse {
  exitCode: number;
  path: string;
  newPath?: string;
}

/**
 * File information interface
 */
export interface FileInfo {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modified: Date;
  created: Date;
}

/**
 * Request interface for listing files
 */
export interface ListFilesRequest {
  id: string;  // Session ID
  path: string;
}

/**
 * Response interface for listing files
 */
export interface ListFilesResponse extends BaseApiResponse {
  exitCode: number;
  files: FileInfo[];
  path: string;
}

/**
 * Client for file system operations
 */
export class FileClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super(options);
  }

  /**
   * Create a directory
   */
  async mkdir(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean }
  ): Promise<MkdirResponse> {
    try {
      const data: MkdirRequest = {
        id: sessionId,
        path,
        recursive: options?.recursive ?? false,
      };

      const response = await this.post<MkdirResponse>('/api/mkdir', data);
      
      this.logSuccess('Directory created', `${path} (recursive: ${data.recursive})`);
      return response;
    } catch (error) {
      this.logError('mkdir', error);
      throw error;
    }
  }

  /**
   * Write content to a file
   */
  async writeFile(
    path: string,
    content: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<WriteFileResponse> {
    try {
      const data: WriteFileRequest = {
        id: sessionId,
        path,
        content,
        encoding: options?.encoding ?? 'utf8',
      };

      const response = await this.post<WriteFileResponse>('/api/write', data);
      
      this.logSuccess('File written', `${path} (${content.length} chars)`);
      return response;
    } catch (error) {
      this.logError('writeFile', error);
      throw error;
    }
  }

  /**
   * Read content from a file
   */
  async readFile(
    path: string,
    sessionId: string,
    options?: { encoding?: string }
  ): Promise<ReadFileResponse> {
    try {
      const data: ReadFileRequest = {
        id: sessionId,
        path,
        encoding: options?.encoding ?? 'utf8',
      };

      const response = await this.post<ReadFileResponse>('/api/read', data);
      
      this.logSuccess('File read', `${path} (${response.content?.length || 0} chars)`);
      return response;
    } catch (error) {
      this.logError('readFile', error);
      throw error;
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(
    path: string,
    sessionId: string
  ): Promise<FileOperationResponse> {
    try {
      const data: FileOperationRequest = { id: sessionId, path };

      const response = await this.post<FileOperationResponse>('/api/delete', data);
      
      this.logSuccess('File deleted', path);
      return response;
    } catch (error) {
      this.logError('deleteFile', error);
      throw error;
    }
  }

  /**
   * Rename a file
   */
  async renameFile(
    path: string,
    newPath: string,
    sessionId: string
  ): Promise<FileOperationResponse> {
    try {
      const data = { id: sessionId, oldPath: path, newPath };

      const response = await this.post<FileOperationResponse>('/api/rename', data);
      
      this.logSuccess('File renamed', `${path} -> ${newPath}`);
      return response;
    } catch (error) {
      this.logError('renameFile', error);
      throw error;
    }
  }

  /**
   * Move a file
   */
  async moveFile(
    path: string,
    newPath: string,
    sessionId: string
  ): Promise<FileOperationResponse> {
    try {
      const data = { id: sessionId, sourcePath: path, destinationPath: newPath };

      const response = await this.post<FileOperationResponse>('/api/move', data);
      
      this.logSuccess('File moved', `${path} -> ${newPath}`);
      return response;
    } catch (error) {
      this.logError('moveFile', error);
      throw error;
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(
    path: string,
    sessionId: string
  ): Promise<ListFilesResponse> {
    try {
      const data: ListFilesRequest = { id: sessionId, path };

      const response = await this.post<ListFilesResponse>('/api/list', data);
      
      this.logSuccess('Files listed', `${path} (${response.files.length} items)`);
      return response;
    } catch (error) {
      this.logError('listFiles', error);
      throw error;
    }
  }
}