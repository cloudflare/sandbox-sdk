import { BaseHttpClient } from './base-client';
import type { BaseApiResponse, HttpClientOptions, SessionRequest } from './types';

/**
 * Request interface for creating directories
 */
export interface MkdirRequest extends SessionRequest {
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
export interface WriteFileRequest extends SessionRequest {
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
export interface ReadFileRequest extends SessionRequest {
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
export interface FileOperationRequest extends SessionRequest {
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
    options?: { recursive?: boolean; sessionId?: string }
  ): Promise<MkdirResponse> {
    try {
      const data = this.withSession({
        path,
        recursive: options?.recursive ?? false,
      }, options?.sessionId);

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
    options?: { encoding?: string; sessionId?: string }
  ): Promise<WriteFileResponse> {
    try {
      const data = this.withSession({
        path,
        content,
        encoding: options?.encoding ?? 'utf8',
      }, options?.sessionId);

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
    options?: { encoding?: string; sessionId?: string }
  ): Promise<ReadFileResponse> {
    try {
      const data = this.withSession({
        path,
        encoding: options?.encoding ?? 'utf8',
      }, options?.sessionId);

      const response = await this.post<ReadFileResponse>('/api/read', data);
      
      this.logSuccess('File read', `${path} (${response.content.length} chars)`);
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
    sessionId?: string
  ): Promise<FileOperationResponse> {
    try {
      const data = this.withSession({ path }, sessionId);

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
    sessionId?: string
  ): Promise<FileOperationResponse> {
    try {
      const data = this.withSession({ oldPath: path, newPath }, sessionId);

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
    sessionId?: string
  ): Promise<FileOperationResponse> {
    try {
      const data = this.withSession({ sourcePath: path, destinationPath: newPath }, sessionId);

      const response = await this.post<FileOperationResponse>('/api/move', data);
      
      this.logSuccess('File moved', `${path} -> ${newPath}`);
      return response;
    } catch (error) {
      this.logError('moveFile', error);
      throw error;
    }
  }
}