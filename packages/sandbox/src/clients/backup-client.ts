import type {
  CreateBackupRequest,
  CreateBackupResponse,
  RestoreBackupRequest,
  RestoreBackupResponse,
  SandboxBackupAPI,
  UploadPartsRequest,
  UploadPartsResponse
} from '@repo/shared';
import { BaseHttpClient } from './base-client';

/**
 * Client for backup operations.
 *
 * Handles communication with the container's backup endpoints.
 * The container creates/extracts squashfs archives locally.
 * R2 upload/download is handled by the Sandbox DO, not by this client.
 */
export class BackupClient extends BaseHttpClient implements SandboxBackupAPI {
  /**
   * Tell the container to create a squashfs archive from a directory.
   * @param dir - Directory to back up
   * @param archivePath - Where the container should write the archive
   * @param sessionId - Session context
   */
  async createArchive(
    dir: string,
    archivePath: string,
    sessionId: string,
    options?: {
      excludes?: string[];
      gitignore?: boolean;
      compression?: CreateBackupRequest['compression'];
    }
  ): Promise<CreateBackupResponse> {
    const data: CreateBackupRequest = {
      dir,
      archivePath,
      gitignore: options?.gitignore ?? false,
      excludes: options?.excludes ?? [],
      compression: options?.compression,
      sessionId
    };

    const response = await this.post<CreateBackupResponse>(
      '/api/backup/create',
      data
    );

    return response;
  }

  /**
   * Tell the container to restore a squashfs archive into a directory.
   * @param dir - Target directory
   * @param archivePath - Path to the archive file in the container
   * @param sessionId - Session context
   */
  async restoreArchive(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<RestoreBackupResponse> {
    const data: RestoreBackupRequest = {
      dir,
      archivePath,
      sessionId
    };

    const response = await this.post<RestoreBackupResponse>(
      '/api/backup/restore',
      data
    );

    return response;
  }

  async uploadParts(
    request: UploadPartsRequest,
    sessionId?: string
  ): Promise<UploadPartsResponse> {
    return this.post<UploadPartsResponse>('/api/backup/upload-parts', {
      ...request,
      sessionId: sessionId ?? request.sessionId
    });
  }
}
