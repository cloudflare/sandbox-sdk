import type {
  CreateBackupRequest,
  CreateBackupResponse,
  RestoreBackupRequest,
  RestoreBackupResponse
} from '@repo/shared';
import { BaseHttpClient } from './base-client';

/**
 * Client for backup operations.
 *
 * Handles communication with the container's backup endpoints.
 * The container creates/extracts squashfs archives locally.
 * R2 upload/download is handled by the Sandbox DO, not by this client.
 */
export class BackupClient extends BaseHttpClient {
  /**
   * Tell the container to create a squashfs archive from a directory.
   * @param dir - Directory to back up
   * @param archivePath - Where the container should write the archive
   * @param sessionId - Session context
   */
  async createArchive(
    dir: string,
    archivePath: string,
    sessionId: string
  ): Promise<CreateBackupResponse> {
    try {
      const data: CreateBackupRequest = {
        dir,
        archivePath,
        sessionId
      };

      const response = await this.post<CreateBackupResponse>(
        '/api/backup/create',
        data
      );

      this.logSuccess('Backup archive created', `${dir} -> ${archivePath}`);
      return response;
    } catch (error) {
      this.logError('createArchive', error);
      throw error;
    }
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
    try {
      const data: RestoreBackupRequest = {
        dir,
        archivePath,
        sessionId
      };

      const response = await this.post<RestoreBackupResponse>(
        '/api/backup/restore',
        data
      );

      this.logSuccess('Backup archive restored', `${archivePath} -> ${dir}`);
      return response;
    } catch (error) {
      this.logError('restoreArchive', error);
      throw error;
    }
  }
}
