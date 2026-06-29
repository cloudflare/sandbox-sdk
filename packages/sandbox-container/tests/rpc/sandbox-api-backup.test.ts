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
      })
    } as unknown as BackupService;
  });

  it('accepts backup session IDs inside options objects', async () => {
    const api = buildApi(mockBackupService);

    await api.backup.createArchive('/workspace/app', '/var/backups/app.sqsh', {
      sessionId: 'session-1',
      gitignore: true,
      excludes: ['node_modules'],
      compression: {
        format: 'zstd',
        threads: 2
      }
    });
    await api.backup.restoreArchive('/workspace/app', '/var/backups/app.sqsh', {
      sessionId: 'session-1'
    });

    expect(mockBackupService.createArchive).toHaveBeenCalledWith(
      '/workspace/app',
      '/var/backups/app.sqsh',
      'session-1',
      true,
      ['node_modules'],
      { format: 'zstd', threads: 2 }
    );
    expect(mockBackupService.restoreArchive).toHaveBeenCalledWith(
      '/workspace/app',
      '/var/backups/app.sqsh',
      'session-1'
    );
  });
});
