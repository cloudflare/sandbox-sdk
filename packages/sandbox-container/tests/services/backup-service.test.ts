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
        if (command.includes('ls-files --others -i --exclude-standard -- .')) {
          return execSuccess('node_modules/a.txt\n');
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
      true
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
    expect(writeExcludeCommand).toContain("'.git'");
    expect(writeExcludeCommand).not.toContain("'/workspace/repo/app/");
  });

  it('does not add exclude flags when git exclusions are unavailable', async () => {
    const dir = '/workspace/non-git-dir';
    const archivePath = '/var/backups/test-no-exclude.sqsh';

    mocked(mockSessionManager.executeInSession).mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command === 'command -v git >/dev/null 2>&1') return execSuccess();
        if (command.includes('rev-parse --is-inside-work-tree')) {
          return execResult(1, 'false\n');
        }
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
      true
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
  });
});
