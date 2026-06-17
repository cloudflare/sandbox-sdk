import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import type { ServiceResult } from '@sandbox-container/core/types';
import { BackupService } from '@sandbox-container/services/backup-service';
import type { ExecutionService } from '@sandbox-container/services/execution-service';
import type { RawExecResult } from '@sandbox-container/session-types';
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
  startProcessStreamInSession: vi.fn(),
  killCommand: vi.fn(),
  setEnvVars: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
  destroy: vi.fn(),
  withSession: vi.fn()
};

const mockExecutionService = {
  execute: vi.fn(),
  startProcessStream: vi.fn(),
  withExecution: vi.fn(),
  kill: vi.fn()
} as unknown as ExecutionService;

const mockFetch = vi.fn();
let originalFetch: typeof fetch;

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
    originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    mocked(mockExecutionService.execute).mockImplementation(
      async (command, options = {}) => {
        const sessionId = options.sessionId ?? 'default';
        return await mockSessionManager.executeInSession(sessionId, command);
      }
    );
    service = new BackupService(mockLogger, mockExecutionService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('allows creating an archive from /app', async () => {
    const dir = '/app/project';
    const archivePath = '/var/backups/app-dir.sqsh';

    mockSessionManager.executeInSession.mockImplementation(
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

    mockSessionManager.executeInSession.mockImplementation(
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

  describe('uploadParts', () => {
    it('uploads archive parts with Bun file slices and returns sorted etags', async () => {
      const archivePath = '/var/backups/test.sqsh';
      const sliceA = new Blob(['part-a']);
      const sliceB = new Blob(['part-b']);
      const bunFile = {
        exists: async () => true,
        slice: vi.fn().mockReturnValueOnce(sliceA).mockReturnValueOnce(sliceB)
      } as unknown as ReturnType<typeof Bun.file>;
      vi.spyOn(Bun, 'file').mockReturnValue(bunFile);

      mockFetch
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: { etag: '"etag-2"' }
          })
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: { etag: '"etag-1"' }
          })
        );

      const result = await service.uploadParts(archivePath, [
        {
          partNumber: 2,
          url: 'https://example.com/part-2',
          offset: 10,
          size: 5
        },
        {
          partNumber: 1,
          url: 'https://example.com/part-1',
          offset: 0,
          size: 10
        }
      ]);

      expect(result.success).toBe(true);
      expect(bunFile.slice).toHaveBeenNthCalledWith(1, 10, 15);
      expect(bunFile.slice).toHaveBeenNthCalledWith(2, 0, 10);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://example.com/part-2',
        expect.objectContaining({
          method: 'PUT',
          body: sliceA,
          headers: {
            'Content-Length': '5',
            'Content-Type': 'application/octet-stream'
          }
        })
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://example.com/part-1',
        expect.objectContaining({
          method: 'PUT',
          body: sliceB,
          headers: {
            'Content-Length': '10',
            'Content-Type': 'application/octet-stream'
          }
        })
      );
      expect(result).toEqual({
        success: true,
        data: {
          parts: [
            { partNumber: 1, etag: '"etag-1"' },
            { partNumber: 2, etag: '"etag-2"' }
          ]
        }
      });
    });

    it('fails when the archive does not exist', async () => {
      vi.spyOn(Bun, 'file').mockReturnValue({
        exists: async () => false,
        slice: vi.fn()
      } as unknown as ReturnType<typeof Bun.file>);

      const result = await service.uploadParts('/var/backups/missing.sqsh', [
        {
          partNumber: 1,
          url: 'https://example.com/part-1',
          offset: 0,
          size: 10
        }
      ]);

      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
      if (!result.success) {
        expect(result.error.message).toContain('Backup archive does not exist');
      }
    });

    it('retries a failed part upload and succeeds when a later attempt returns an etag', async () => {
      const slice = new Blob(['part-a']);
      vi.spyOn(Bun, 'file').mockReturnValue({
        exists: async () => true,
        slice: vi.fn().mockReturnValue(slice)
      } as unknown as ReturnType<typeof Bun.file>);
      mockFetch
        .mockRejectedValueOnce(new Error('socket reset'))
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: { etag: '"etag-1"' }
          })
        );

      const result = await service.uploadParts('/var/backups/test.sqsh', [
        {
          partNumber: 1,
          url: 'https://example.com/part-1',
          offset: 0,
          size: 10
        }
      ]);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        success: true,
        data: {
          parts: [{ partNumber: 1, etag: '"etag-1"' }]
        }
      });
    });

    it('fails when a part upload does not include an etag header', async () => {
      vi.spyOn(Bun, 'file').mockReturnValue({
        exists: async () => true,
        slice: vi.fn().mockReturnValue(new Blob(['part-a']))
      } as unknown as ReturnType<typeof Bun.file>);
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 200
        })
      );

      const result = await service.uploadParts('/var/backups/test.sqsh', [
        {
          partNumber: 1,
          url: 'https://example.com/part-1',
          offset: 0,
          size: 10
        }
      ]);

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      if (!result.success) {
        expect(result.error.message).toContain(
          'response did not include an ETag header'
        );
      }
    });

    it('fails the entire upload when a part exhausts all retry attempts', async () => {
      vi.spyOn(Bun, 'file').mockReturnValue({
        exists: async () => true,
        slice: vi.fn().mockReturnValue(new Blob(['part-a']))
      } as unknown as ReturnType<typeof Bun.file>);
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 503
        })
      );

      const result = await service.uploadParts('/var/backups/test.sqsh', [
        {
          partNumber: 1,
          url: 'https://example.com/part-1',
          offset: 0,
          size: 10
        }
      ]);

      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      if (!result.success) {
        expect(result.error.message).toContain('part 1 failed with HTTP 503');
      }
    });
  });

  it('uses wildcard exclude mode for gitignore-derived excludes', async () => {
    const dir = '/workspace/repo/app';
    const archivePath = '/var/backups/test.sqsh';

    mockSessionManager.executeInSession.mockImplementation(
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

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );
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

    mockSessionManager.executeInSession.mockImplementation(
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

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );
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

    mockSessionManager.executeInSession.mockImplementation(
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

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );
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

    mockSessionManager.executeInSession.mockImplementation(
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

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );
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

    mockSessionManager.executeInSession.mockImplementation(
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

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );

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

    mockSessionManager.executeInSession.mockImplementation(
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

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );
    expect(
      callArgs.some(
        (command) =>
          command === "rm -f '/var/backups/cleanup-on-throw.sqsh.exclude'"
      )
    ).toBe(true);
  });

  it('normalizes globstar excludes before passing to mksquashfs', async () => {
    const dir = '/workspace/app';
    const archivePath = '/var/backups/globstar-excludes.sqsh';

    mockSessionManager.executeInSession.mockImplementation(
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
      ['**/node_modules/.cache', '**/.next/cache', '**/.turbo', '**/dist']
    );
    expect(result.success).toBe(true);

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );

    const writeExcludeCommand = callArgs.find((command) =>
      command.startsWith("printf '%s\\n' ")
    );
    expect(writeExcludeCommand).toBeDefined();

    // Patterns should be normalized: no ** prefixes
    expect(writeExcludeCommand).toContain("'node_modules/.cache'");
    expect(writeExcludeCommand).toContain("'... node_modules/.cache'");
    expect(writeExcludeCommand).toContain("'.next/cache'");
    expect(writeExcludeCommand).toContain("'.turbo'");
    expect(writeExcludeCommand).toContain("'dist'");

    // Original ** patterns must NOT appear
    expect(writeExcludeCommand).not.toContain('**/node_modules');
    expect(writeExcludeCommand).not.toContain('**/.next');
    expect(writeExcludeCommand).not.toContain('**/.turbo');
    expect(writeExcludeCommand).not.toContain('**/dist');

    // Should have logged warnings about normalization
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Exclude pattern contained ** (globstar) which mksquashfs does not support; normalized automatically',
      expect.objectContaining({
        original: '**/node_modules/.cache',
        normalized: 'node_modules/.cache'
      })
    );
  });

  it('does not add exclude flags when gitignore is false in non-git directories', async () => {
    const dir = '/workspace/non-git-dir';
    const archivePath = '/var/backups/test-no-exclude.sqsh';

    mockSessionManager.executeInSession.mockImplementation(
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

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );
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

  describe('normalizeMksquashfsPattern', () => {
    it('strips leading **/', () => {
      expect(BackupService.normalizeMksquashfsPattern('**/node_modules')).toBe(
        'node_modules'
      );
      expect(
        BackupService.normalizeMksquashfsPattern('**/node_modules/.cache')
      ).toBe('node_modules/.cache');
      expect(BackupService.normalizeMksquashfsPattern('**/.next/cache')).toBe(
        '.next/cache'
      );
    });

    it('strips repeated leading **/', () => {
      expect(
        BackupService.normalizeMksquashfsPattern('**/**/node_modules')
      ).toBe('node_modules');
    });

    it('replaces mid-pattern /**/ with /', () => {
      expect(BackupService.normalizeMksquashfsPattern('src/**/test')).toBe(
        'src/test'
      );
      expect(BackupService.normalizeMksquashfsPattern('a/**/**/b')).toBe('a/b');
      expect(BackupService.normalizeMksquashfsPattern('a/**/b/**/c')).toBe(
        'a/b/c'
      );
    });

    it('strips trailing /**', () => {
      expect(BackupService.normalizeMksquashfsPattern('dist/**')).toBe('dist');
    });

    it('handles combined leading and trailing **', () => {
      expect(BackupService.normalizeMksquashfsPattern('**/dist/**')).toBe(
        'dist'
      );
    });

    it('returns null for pure ** patterns', () => {
      expect(BackupService.normalizeMksquashfsPattern('**')).toBeNull();
      expect(BackupService.normalizeMksquashfsPattern('**/**')).toBeNull();
    });

    it('passes through patterns without **', () => {
      expect(BackupService.normalizeMksquashfsPattern('node_modules')).toBe(
        'node_modules'
      );
      expect(BackupService.normalizeMksquashfsPattern('*.log')).toBe('*.log');
      expect(BackupService.normalizeMksquashfsPattern('.cache')).toBe('.cache');
    });
  });
});
