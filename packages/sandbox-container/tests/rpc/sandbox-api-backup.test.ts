import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { BackupService } from '@sandbox-container/services/backup-service';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

function buildApi(backupService: BackupService): SandboxControlAPI {
  return new SandboxControlAPI({
    backupService,
    logger: mockLogger
  } as unknown as SandboxAPIDeps);
}

describe('SandboxControlAPI backup', () => {
  let mockBackupService: BackupService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBackupService = {
      createArchive: vi.fn().mockResolvedValue({
        success: true,
        data: {
          sizeBytes: 42,
          archivePath: '/var/backups/test.sqsh'
        }
      }),
      restoreArchive: vi.fn().mockResolvedValue({
        success: true,
        data: undefined
      }),
      uploadArchive: vi
        .fn()
        .mockResolvedValue({ success: true, data: undefined }),
      uploadParts: vi
        .fn()
        .mockResolvedValue({ success: true, data: { parts: [] } }),
      prepareRestore: vi
        .fn()
        .mockResolvedValue({ success: true, data: { existingSize: 0 } }),
      downloadArchive: vi
        .fn()
        .mockResolvedValue({ success: true, data: undefined }),
      extractArchive: vi
        .fn()
        .mockResolvedValue({ success: true, data: undefined }),
      cleanupArchive: vi
        .fn()
        .mockResolvedValue({ success: true, data: undefined })
    } as unknown as BackupService;
  });

  it('routes backup calls to stateless service operations', async () => {
    const api = buildApi(mockBackupService);

    await api.backup.createArchive('/workspace/app', '/var/backups/app.sqsh', {
      gitignore: true,
      excludes: ['node_modules'],
      compression: {
        format: 'zstd',
        threads: 2
      }
    });
    await api.backup.restoreArchive('/workspace/app', '/var/backups/app.sqsh');
    await api.backup.uploadArchive({
      archivePath: '/var/backups/app.sqsh',
      url: 'https://example.com/upload',
      timeoutMs: 1_810_000
    });
    await api.backup.downloadArchive({
      archivePath: '/var/backups/app.sqsh',
      expectedSize: 42,
      parts: [{ url: 'https://example.com/download', offset: 0 }],
      timeoutMs: 1_810_000
    });
    await api.backup.cleanupArchive('/var/backups/app.sqsh');

    expect(mockBackupService.createArchive).toHaveBeenCalledWith(
      '/workspace/app',
      '/var/backups/app.sqsh',
      true,
      ['node_modules'],
      { format: 'zstd', threads: 2 }
    );
    expect(mockBackupService.restoreArchive).toHaveBeenCalledWith(
      '/workspace/app',
      '/var/backups/app.sqsh'
    );
    expect(mockBackupService.uploadArchive).toHaveBeenCalledWith({
      archivePath: '/var/backups/app.sqsh',
      url: 'https://example.com/upload',
      timeoutMs: 1_810_000
    });
    expect(mockBackupService.downloadArchive).toHaveBeenCalledWith({
      archivePath: '/var/backups/app.sqsh',
      expectedSize: 42,
      parts: [{ url: 'https://example.com/download', offset: 0 }],
      timeoutMs: 1_810_000
    });
    expect(mockBackupService.cleanupArchive).toHaveBeenCalledWith(
      '/var/backups/app.sqsh'
    );
  });
});
