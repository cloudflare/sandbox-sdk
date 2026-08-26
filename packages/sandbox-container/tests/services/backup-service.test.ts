import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { ServiceResult } from '@sandbox-container/core/types';
import { BackupService } from '@sandbox-container/services/backup-service';
import type { ExecutionService } from '@sandbox-container/services/execution-service';
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
};

const mockExecutionService = {
  execute: vi.fn(),
  executeStream: vi.fn(),
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

function encodeGitPaths(paths: string): string {
  return Buffer.from(paths).toString('base64');
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

  it('merges Git paths and user patterns without losing recursive expansion', async () => {
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
          command.includes('ls-files -z --others -i --exclude-standard -- .')
        ) {
          return execSuccess(
            encodeGitPaths(
              'node_modules/a.txt\0build output/日本語 file.txt\0.cache\0...foo\0'
            )
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
      ['...foo']
    );

    expect(result.success).toBe(true);

    const callArgs = mockSessionManager.executeInSession.mock.calls.map(
      ([, command]) => command
    );
    expect(callArgs.some((command) => command.includes('| base64 -w0'))).toBe(
      true
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
    expect(writeExcludeCommand).not.toContain("'... node_modules/a.txt'");
    expect(writeExcludeCommand).not.toContain(
      "'... build output/日本語 file.txt'"
    );
    expect(writeExcludeCommand).toContain("'.cache'");
    expect(writeExcludeCommand).not.toContain("'... .cache'");
    expect(writeExcludeCommand?.match(/'\.\.\.foo'/g)).toHaveLength(1);
    expect(writeExcludeCommand).toContain("'... ...foo'");
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
          command.includes('ls-files -z --others -i --exclude-standard -- .')
        ) {
          return execSuccess(
            encodeGitPaths(
              'config[1].json\0backup-2024*.log\0q?.txt\0folder\\name.txt\0'
            )
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
    expect(writeExcludeCommand).not.toContain("'... config\\[1\\].json'");
  });

  it('warns and skips gitignored paths that cannot be represented safely', async () => {
    const dir = '/workspace/repo/app';
    const archivePath = '/var/backups/unsafe-git-path.sqsh';

    mockSessionManager.executeInSession.mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');
        if (command === 'command -v git >/dev/null 2>&1') return execSuccess();
        if (command.includes('rev-parse --is-inside-work-tree'))
          return execSuccess('true\n');
        if (command.includes('ls-files -z --others')) {
          return execSuccess(
            encodeGitPaths(
              `safe/path\0...foo\0${'x'.repeat(210)}\nforged\0... foo\0 keep \0\u007fname\0bad\rname\0bad\tname\0trailing \0`
            )
          );
        }
        if (command.startsWith("printf '%s\\n' ")) return execSuccess();
        if (command.startsWith('/usr/bin/mksquashfs ')) return execSuccess();
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
      true
    );

    expect(result.success).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Some gitignored paths cannot be represented safely; including them in the backup',
      { count: 7 }
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Sample of unrepresentable gitignored backup paths',
      {
        sample: [
          JSON.stringify('x'.repeat(200)),
          '"... foo"',
          '" keep "',
          '"\\u007fname"',
          '"bad\\rname"'
        ],
        omittedCount: 2
      }
    );
    const writeExcludeCommand = mockSessionManager.executeInSession.mock.calls
      .map(([, command]) => command)
      .find((command) => command.startsWith("printf '%s\\n' "));
    expect(writeExcludeCommand).toContain("'safe/path'");
    expect(writeExcludeCommand).toContain("'...foo'");
    expect(writeExcludeCommand).not.toContain("'... ...foo'");
    expect(writeExcludeCommand).not.toContain('forged');
    expect(writeExcludeCommand).not.toContain('... foo');
    expect(writeExcludeCommand).not.toContain(' keep ');
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
      ['node_modules', '*.log', 'logs/**.log', 'foo**/bar']
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
    expect(writeExcludeCommand).toContain("'logs/**.log'");
    expect(writeExcludeCommand).not.toContain("'... logs/**.log'");
    expect(writeExcludeCommand).toContain("'foo**/bar'");

    // git should not be invoked when gitignore is false
    expect(
      callArgs.some((command) => command === 'command -v git >/dev/null 2>&1')
    ).toBe(false);
  });

  it.each([
    { input: 'node_modules', normalized: 'node_modules', sticky: true },
    { input: 'node_modules/', normalized: 'node_modules', sticky: true },
    { input: 'nested/path', normalized: 'nested/path', sticky: false },
    { input: 'nested/path/', normalized: 'nested/path', sticky: false },
    {
      input: 'packages/foo/node_modules/',
      normalized: 'packages/foo/node_modules',
      sticky: false
    },
    { input: 'alpha/beta', normalized: 'alpha/beta', sticky: false },
    { input: 'alpha/beta/', normalized: 'alpha/beta', sticky: false },
    { input: 'dist', normalized: 'dist', sticky: true },
    { input: 'dist/', normalized: 'dist', sticky: true },
    { input: 'dist/**', normalized: 'dist', sticky: false },
    { input: 'packages/app/**', normalized: 'packages/app', sticky: false },
    { input: '**/tree/**', normalized: 'tree', sticky: true },
    { input: '**/dist', normalized: 'dist', sticky: true },
    { input: '**/dist/', normalized: 'dist', sticky: true },
    { input: '**/dist/**', normalized: 'dist', sticky: true },
    { input: '**/**/cache', normalized: 'cache', sticky: true },
    { input: 'a/b', normalized: 'a/b', sticky: false },
    {
      input: '.cache/foo/*/node_modules',
      normalized: '.cache/foo/*/node_modules',
      sticky: false
    },
    { input: '*/*', normalized: '*/*', sticky: false },
    { input: 'a/*', normalized: 'a/*', sticky: false },
    { input: '?', normalized: '?', sticky: true },
    { input: '?*?', normalized: '?*?', sticky: true },
    { input: '*.log', normalized: '*.log', sticky: true },
    { input: 'logs/**.log', normalized: 'logs/**.log', sticky: false },
    { input: 'foo**/bar', normalized: 'foo**/bar', sticky: false },
    { input: '...foo', normalized: '...foo', sticky: true }
  ])(
    'expands $input with sticky=$sticky',
    async ({ input, normalized, sticky }) => {
      const dir = '/workspace/app';
      const archivePath = '/var/backups/pattern-matrix.sqsh';

      mockSessionManager.executeInSession.mockImplementation(
        async (_sessionId: string, command: string) => {
          if (command.startsWith('mkdir -p ')) return execSuccess();
          if (command.startsWith('test -d ')) return execSuccess();
          if (command.includes('test -x /usr/bin/mksquashfs'))
            return execSuccess('exists\n');
          if (command.startsWith("printf '%s\\n' ")) return execSuccess();
          if (command.startsWith('/usr/bin/mksquashfs ')) return execSuccess();
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
        [input]
      );

      expect(result.success).toBe(true);
      const writeExcludeCommand = mockSessionManager.executeInSession.mock.calls
        .map(([, command]) => command)
        .find((command) => command.startsWith("printf '%s\\n' "));
      expect(writeExcludeCommand).toContain(`'${normalized}'`);
      if (sticky) {
        expect(writeExcludeCommand).toContain(`'... ${normalized}'`);
      } else {
        expect(writeExcludeCommand).not.toContain(`'... ${normalized}'`);
      }
    }
  );

  it('does not make multi-component exclude patterns sticky', async () => {
    const dir = '/workspace/app';
    const archivePath = '/var/backups/nested-excludes.sqsh';

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
      ['.cache/foo/*/node_modules', 'node_modules']
    );
    expect(result.success).toBe(true);

    const writeExcludeCommand = mockSessionManager.executeInSession.mock.calls
      .map(([, command]) => command)
      .find((command) => command.startsWith("printf '%s\\n' "));
    expect(writeExcludeCommand).toBeDefined();
    expect(writeExcludeCommand).toContain("'.cache/foo/*/node_modules'");
    expect(writeExcludeCommand).not.toContain(
      "'... .cache/foo/*/node_modules'"
    );
    expect(writeExcludeCommand).toContain("'... node_modules'");
  });

  it('rejects unsafe exclude patterns', async () => {
    const dir = '/workspace/app';
    const archivePath = '/var/backups/recursive-nested-excludes.sqsh';

    mockSessionManager.executeInSession.mockImplementation(
      async (_sessionId: string, command: string) => {
        if (command.startsWith('mkdir -p ')) return execSuccess();
        if (command.startsWith('test -d ')) return execSuccess();
        if (command.includes('test -x /usr/bin/mksquashfs'))
          return execSuccess('exists\n');

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

    for (const pattern of [
      '',
      '*',
      '**',
      '**/',
      '***',
      '***/',
      '*?',
      '?*',
      '*?*',
      '**?**',
      '**/***',
      '***/**',
      '**/*?/**',
      '**/*',
      '*/',
      '**/*/',
      '*/**',
      '**/*/**',
      '**/node_modules/.cache',
      '**/a/b/',
      '**/packages/app/**',
      'src/**/cache',
      'foo/**/**',
      '/',
      '/rooted',
      'line\nbreak',
      '... alpha/beta',
      ' ... alpha/beta',
      'bounded ',
      'a//b',
      'dist//',
      '**/dist//',
      'a/./b',
      'a/../b'
    ]) {
      const result = await service.createArchive(
        dir,
        archivePath,
        'default',
        false,
        [pattern]
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.INVALID_BACKUP_CONFIG);
        expect(result.error.message).toContain(
          'Invalid backup exclude pattern'
        );
      }
    }
    expect(
      mockSessionManager.executeInSession.mock.calls.some(([, command]) =>
        command.startsWith('/usr/bin/mksquashfs ')
      )
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
          command.includes('ls-files -z --others -i --exclude-standard -- .')
        ) {
          return execSuccess(encodeGitPaths('node_modules/a.txt\0'));
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

  it('expands globstar excludes before passing to mksquashfs', async () => {
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
      [
        '**/node_modules',
        'node_modules/',
        '**/.turbo',
        'dist/**',
        'packages/app/**'
      ]
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
    expect(writeExcludeCommand).toContain("'node_modules'");
    expect(writeExcludeCommand).toContain("'... node_modules'");
    expect(writeExcludeCommand).toContain("'.turbo'");
    expect(writeExcludeCommand).toContain("'... .turbo'");
    expect(writeExcludeCommand).toContain("'dist'");
    expect(writeExcludeCommand).not.toContain("'... dist'");
    expect(writeExcludeCommand).toContain("'packages/app'");
    expect(writeExcludeCommand).not.toContain("'... packages/app'");

    // Original ** patterns must NOT appear
    expect(writeExcludeCommand).not.toContain('**/node_modules');
    expect(writeExcludeCommand).not.toContain('**/.turbo');
    expect(writeExcludeCommand).not.toContain('dist/**');
    expect(writeExcludeCommand).not.toContain('packages/app/**');
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
});
