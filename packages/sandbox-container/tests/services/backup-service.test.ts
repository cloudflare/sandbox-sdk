import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import type { ServiceResult } from '@sandbox-container/core/types';
import { BackupService } from '@sandbox-container/services/backup-service';
import type { SessionManager } from '@sandbox-container/services/session-manager';
import type { RawExecResult } from '@sandbox-container/session';
import { mocked } from '../test-utils';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

const mockSessionManager = {
  executeInSession: vi.fn(),
  executeStreamInSession: vi.fn(),
  killCommand: vi.fn(),
  setEnvVars: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
  destroy: vi.fn(),
  withSession: vi.fn()
} as unknown as SessionManager;

function execResult(
  exitCode: number,
  stdout = '',
  stderr = ''
): ServiceResult<RawExecResult> {
  return {
    success: true,
    data: {
      exitCode,
      stdout,
      stderr,
      command: '',
      duration: 0,
      timestamp: new Date().toISOString()
    }
  };
}

function execSuccess(stdout = '', stderr = ''): ServiceResult<RawExecResult> {
  return execResult(0, stdout, stderr);
}

describe('BackupService', () => {
  let service: BackupService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BackupService(mockLogger, mockSessionManager);
  });

  it('allows creating an archive from /app', async () => {
    const dir = '/app/project';
    const archivePath = '/var/backups/app-dir.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs')) {
          return execSuccess('exists\n');
        }
        if (command.startsWith('/usr/bin/mksquashfs ')) return execSuccess();
        if (command.startsWith('stat -c %s ')) return execSuccess('42\n');

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(dir, archivePath);

    expect(result.success).toBe(true);
  });

  it('allows restoring an archive into /app', async () => {
    const dir = '/app/project';
    const archivePath = '/var/backups/app-dir.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('test -f ')) return execSuccess();
        if (command.includes('/usr/bin/fusermount3 -u ')) return execSuccess();
        if (command.startsWith('for d in ')) return execSuccess();
        if (command.startsWith('rm -rf ')) return execSuccess();
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('/usr/bin/squashfuse ')) return execSuccess();
        if (command.startsWith('/usr/bin/fuse-overlayfs '))
          return execSuccess();

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.restoreArchive(dir, archivePath);

    expect(result.success).toBe(true);
  });

  it('uses wildcard exclude mode for gitignore-derived excludes', async () => {
    const dir = '/workspace/repo/app';
    const archivePath = '/var/backups/test.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command === 'command -v git >/dev/null 2>&1') return execSuccess();
        if (command.includes('rev-parse --is-inside-work-tree'))
          return execSuccess('true\n');
        if (
          command.includes(
            '-c core.quotePath=false ls-files --others -i --exclude-standard -- .'
          )
        ) {
          return execSuccess(
            'node_modules/a.txt\nbuild output/日本語 file.txt\n'
          );
        }
        if (command.startsWith("printf '%s\\n' ")) return execSuccess();
        if (command.includes('/usr/bin/mksquashfs')) return execSuccess();
        if (command.startsWith('rm -f ')) return execSuccess();
        if (command.startsWith('stat -c %s ')) return execSuccess('123\n');

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(
      dir,
      archivePath,
      'default',
      true,
      []
    );

    expect(result.success).toBe(true);

    const callArgs = mocked(mockSessionManager.executeInSession)
      .mock.calls.map(([, command]) => command)
      .filter((command): command is string => typeof command === 'string');

    const squashCommand = callArgs.find((command) =>
      command.startsWith('/usr/bin/mksquashfs ')
    );
    const writeExcludeCommand = callArgs.find((command) =>
      command.startsWith("printf '%s\\n' ")
    );
    expect(squashCommand).toBeDefined();
    expect(writeExcludeCommand).toBeDefined();
    expect(squashCommand).toContain('-wildcards');
    expect(squashCommand).toContain("-ef '/var/backups/test.sqsh.exclude'");
    expect(writeExcludeCommand).toContain("'node_modules/a.txt'");
    expect(writeExcludeCommand).toContain("'build output/日本語 file.txt'");
    expect(writeExcludeCommand).toContain("'... node_modules/a.txt'");
    expect(writeExcludeCommand).toContain("'... build output/日本語 file.txt'");
  });

  it('defaults to including gitignored files when gitignore is omitted', async () => {
    const dir = '/workspace/repo/app';
    const archivePath = '/var/backups/default-no-gitignore.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command.includes('/usr/bin/mksquashfs')) return execSuccess();
        if (command.startsWith('stat -c %s ')) return execSuccess('321\n');

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(dir, archivePath);
    expect(result.success).toBe(true);

    const callArgs = mocked(mockSessionManager.executeInSession)
      .mock.calls.map(([, command]) => command)
      .filter((command): command is string => typeof command === 'string');

    expect(
      callArgs.some((command) => command === 'command -v git >/dev/null 2>&1')
    ).toBe(false);

    const squashCommand = callArgs.find((command) =>
      command.startsWith('/usr/bin/mksquashfs ')
    );
    expect(squashCommand).toBeDefined();
    expect(squashCommand).not.toContain('-wildcards');
    expect(squashCommand).not.toContain('-ef');
  });

  it('succeeds without exclusions when gitignore is true and git is unavailable', async () => {
    const dir = '/workspace/repo/app';
    const archivePath = '/var/backups/git-required.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command === 'command -v git >/dev/null 2>&1') return execResult(1);
        if (command.includes('/usr/bin/mksquashfs')) return execSuccess();
        if (command.startsWith('stat -c %s ')) return execSuccess('100\n');

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(
      dir,
      archivePath,
      'default',
      true,
      []
    );
    expect(result.success).toBe(true);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'gitignore option enabled but git is not installed; skipping git-based exclusions',
      expect.objectContaining({ dir })
    );

    const callArgs = mocked(mockSessionManager.executeInSession)
      .mock.calls.map(([, command]) => command)
      .filter((command): command is string => typeof command === 'string');
    const squashCommand = callArgs.find((command) =>
      command.startsWith('/usr/bin/mksquashfs ')
    );
    expect(squashCommand).toBeDefined();
    expect(squashCommand).not.toContain('-wildcards');
    expect(squashCommand).not.toContain('-ef');
  });

  it('escapes wildcard metacharacters in gitignored file paths', async () => {
    const dir = '/workspace/repo/app';
    const archivePath = '/var/backups/escaped-patterns.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command === 'command -v git >/dev/null 2>&1') return execSuccess();
        if (command.includes('rev-parse --is-inside-work-tree'))
          return execSuccess('true\n');
        if (
          command.includes(
            '-c core.quotePath=false ls-files --others -i --exclude-standard -- .'
          )
        ) {
          return execSuccess(
            'config[1].json\nbackup-2024*.log\nq?.txt\nfolder\\name.txt\n'
          );
        }
        if (command.startsWith("printf '%s\\n' ")) return execSuccess();
        if (command.includes('/usr/bin/mksquashfs')) return execSuccess();
        if (command.startsWith('rm -f ')) return execSuccess();
        if (command.startsWith('stat -c %s ')) return execSuccess('999\n');

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(
      dir,
      archivePath,
      'default',
      true,
      []
    );
    expect(result.success).toBe(true);

    const callArgs = mocked(mockSessionManager.executeInSession)
      .mock.calls.map(([, command]) => command)
      .filter((command): command is string => typeof command === 'string');
    const writeExcludeCommand = callArgs.find((command) =>
      command.startsWith("printf '%s\\n' ")
    );

    expect(writeExcludeCommand).toBeDefined();
    expect(writeExcludeCommand).toContain("'config\\[1\\].json'");
    expect(writeExcludeCommand).toContain("'backup-2024\\*.log'");
    expect(writeExcludeCommand).toContain("'q\\?.txt'");
    expect(writeExcludeCommand).toContain("'folder\\\\name.txt'");
    expect(writeExcludeCommand).toContain("'... config\\[1\\].json'");
  });

  it('applies user-provided excludes patterns', async () => {
    const dir = '/workspace/app';
    const archivePath = '/var/backups/user-excludes.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command.startsWith("printf '%s\\n' ")) return execSuccess();
        if (command.includes('/usr/bin/mksquashfs')) return execSuccess();
        if (command.startsWith('rm -f ')) return execSuccess();
        if (command.startsWith('stat -c %s ')) return execSuccess('500\n');

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(
      dir,
      archivePath,
      'default',
      false,
      ['node_modules', '*.log']
    );
    expect(result.success).toBe(true);

    const callArgs = mocked(mockSessionManager.executeInSession)
      .mock.calls.map(([, command]) => command)
      .filter((command): command is string => typeof command === 'string');

    const squashCommand = callArgs.find((command) =>
      command.startsWith('/usr/bin/mksquashfs ')
    );
    expect(squashCommand).toBeDefined();
    expect(squashCommand).toContain('-wildcards');
    expect(squashCommand).toContain('-ef');

    const writeExcludeCommand = callArgs.find((command) =>
      command.startsWith("printf '%s\\n' ")
    );
    expect(writeExcludeCommand).toBeDefined();
    expect(writeExcludeCommand).toContain("'node_modules'");
    expect(writeExcludeCommand).toContain("'... node_modules'");
    expect(writeExcludeCommand).toContain("'*.log'");
    expect(writeExcludeCommand).toContain("'... *.log'");

    // git should not be invoked when gitignore is false
    expect(
      callArgs.some((command) => command === 'command -v git >/dev/null 2>&1')
    ).toBe(false);
  });

  it('cleans up the exclude file when mksquashfs execution throws', async () => {
    const dir = '/workspace/repo/app';
    const archivePath = '/var/backups/cleanup-on-throw.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command === 'command -v git >/dev/null 2>&1') return execSuccess();
        if (command.includes('rev-parse --is-inside-work-tree'))
          return execSuccess('true\n');
        if (
          command.includes(
            '-c core.quotePath=false ls-files --others -i --exclude-standard -- .'
          )
        ) {
          return execSuccess('node_modules/a.txt\n');
        }
        if (command.startsWith("printf '%s\\n' ")) return execSuccess();
        if (command.startsWith('/usr/bin/mksquashfs ')) {
          throw new Error('mksquashfs threw unexpectedly');
        }
        if (command.startsWith('rm -f ')) return execSuccess();

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(
      dir,
      archivePath,
      'default',
      true,
      []
    );
    expect(result.success).toBe(false);

    const callArgs = mocked(mockSessionManager.executeInSession)
      .mock.calls.map(([, command]) => command)
      .filter((command): command is string => typeof command === 'string');

    expect(
      callArgs.some(
        (command) =>
          command === "rm -f '/var/backups/cleanup-on-throw.sqsh.exclude'"
      )
    ).toBe(true);
  });

  it('does not add exclude flags when gitignore is false in non-git directories', async () => {
    const dir = '/workspace/non-git-dir';
    const archivePath = '/var/backups/test-no-exclude.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command.includes('/usr/bin/mksquashfs')) return execSuccess();
        if (command.startsWith('stat -c %s ')) return execSuccess('456\n');

        return {
          success: false,
          error: {
            message: `Unexpected command in test: ${command}`,
            code: 'TEST_ERROR',
            details: {}
          }
        };
      }
    );

    const result = await service.createArchive(
      dir,
      archivePath,
      'default',
      false
    );

    expect(result.success).toBe(true);

    const callArgs = mocked(mockSessionManager.executeInSession)
      .mock.calls.map(([, command]) => command)
      .filter((command): command is string => typeof command === 'string');

    const squashCommand = callArgs.find((command) =>
      command.startsWith('/usr/bin/mksquashfs ')
    );
    expect(squashCommand).toBeDefined();
    expect(squashCommand).not.toContain('-wildcards');
    expect(squashCommand).not.toContain('-ef');
    expect(
      callArgs.some((command) => command === 'command -v git >/dev/null 2>&1')
    ).toBe(false);
  });
});
