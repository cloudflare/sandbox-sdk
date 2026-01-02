import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { WatchService } from '@sandbox-container/services/watch-service';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as unknown as Logger;
mockLogger.child = vi.fn(() => mockLogger);

describe('WatchService', () => {
  let watchService: WatchService;

  beforeEach(() => {
    vi.clearAllMocks();
    watchService = new WatchService(mockLogger);
  });

  describe('matchGlob', () => {
    // Access private method for testing
    const testMatchGlob = (
      service: WatchService,
      path: string,
      pattern: string
    ): boolean => {
      return (service as any).matchGlob(path, pattern);
    };

    describe('basic patterns', () => {
      it('should match exact filename', () => {
        expect(testMatchGlob(watchService, '/app/file.ts', 'file.ts')).toBe(
          true
        );
        expect(testMatchGlob(watchService, '/app/other.ts', 'file.ts')).toBe(
          false
        );
      });

      it('should match wildcard extension', () => {
        expect(testMatchGlob(watchService, '/app/code.ts', '*.ts')).toBe(true);
        expect(testMatchGlob(watchService, '/app/code.js', '*.ts')).toBe(false);
        expect(testMatchGlob(watchService, '/app/code.tsx', '*.ts')).toBe(
          false
        );
      });

      it('should match wildcard prefix', () => {
        expect(
          testMatchGlob(watchService, '/app/test.spec.ts', '*.spec.ts')
        ).toBe(true);
        expect(testMatchGlob(watchService, '/app/test.ts', '*.spec.ts')).toBe(
          false
        );
      });

      it('should match single character wildcard', () => {
        expect(testMatchGlob(watchService, '/app/file1.ts', 'file?.ts')).toBe(
          true
        );
        expect(testMatchGlob(watchService, '/app/file2.ts', 'file?.ts')).toBe(
          true
        );
        expect(testMatchGlob(watchService, '/app/file12.ts', 'file?.ts')).toBe(
          false
        );
      });
    });

    describe('security - regex metacharacters', () => {
      it('should escape dots literally', () => {
        // Pattern *.ts should NOT match file.tsx (dot is literal, not regex any-char)
        expect(testMatchGlob(watchService, '/app/code.ts', '*.ts')).toBe(true);
        expect(testMatchGlob(watchService, '/app/codexts', '*.ts')).toBe(false);
      });

      it('should escape plus literally', () => {
        expect(
          testMatchGlob(watchService, '/app/file+name.ts', 'file+name.ts')
        ).toBe(true);
        expect(
          testMatchGlob(watchService, '/app/filename.ts', 'file+name.ts')
        ).toBe(false);
      });

      it('should escape caret and dollar literally', () => {
        expect(testMatchGlob(watchService, '/app/$file.ts', '$file.ts')).toBe(
          true
        );
        expect(testMatchGlob(watchService, '/app/^file.ts', '^file.ts')).toBe(
          true
        );
      });

      it('should escape parentheses literally', () => {
        expect(
          testMatchGlob(watchService, '/app/file(1).ts', 'file(1).ts')
        ).toBe(true);
        expect(testMatchGlob(watchService, '/app/file1.ts', 'file(1).ts')).toBe(
          false
        );
      });

      it('should escape brackets literally (prevent character classes)', () => {
        // Pattern [a-z].ts should match literal "[a-z].ts", not "a.ts" through "z.ts"
        expect(testMatchGlob(watchService, '/app/[a-z].ts', '[a-z].ts')).toBe(
          true
        );
        expect(testMatchGlob(watchService, '/app/a.ts', '[a-z].ts')).toBe(
          false
        );
        expect(testMatchGlob(watchService, '/app/m.ts', '[a-z].ts')).toBe(
          false
        );
      });

      it('should escape pipe literally', () => {
        expect(testMatchGlob(watchService, '/app/a|b.ts', 'a|b.ts')).toBe(true);
        expect(testMatchGlob(watchService, '/app/a.ts', 'a|b.ts')).toBe(false);
      });

      it('should escape backslash literally', () => {
        expect(testMatchGlob(watchService, '/app/file\\.ts', 'file\\.ts')).toBe(
          true
        );
      });
    });

    describe('security - ReDoS prevention', () => {
      it('should handle potentially malicious patterns safely', () => {
        // These patterns should complete quickly, not cause catastrophic backtracking
        const start = Date.now();

        // Pattern that could cause ReDoS if not properly escaped
        testMatchGlob(
          watchService,
          '/app/aaaaaaaaaaaaaaaaaaaaaaaaa.ts',
          '*.ts'
        );
        testMatchGlob(watchService, '/app/test.ts', '*.*.*.*');

        const elapsed = Date.now() - start;
        // Should complete in under 100ms, not hang
        expect(elapsed).toBeLessThan(100);
      });
    });

    describe('edge cases', () => {
      it('should match files in any directory', () => {
        expect(testMatchGlob(watchService, '/a/b/c/d/file.ts', '*.ts')).toBe(
          true
        );
      });

      it('should handle empty pattern', () => {
        expect(testMatchGlob(watchService, '/app/file.ts', '')).toBe(false);
      });

      it('should handle pattern with only wildcards', () => {
        expect(testMatchGlob(watchService, '/app/anything', '*')).toBe(true);
      });
    });
  });

  describe('stopWatch', () => {
    it('should return error for non-existent watch', async () => {
      const result = await watchService.stopWatch('non-existent-watch-id');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.WATCH_NOT_FOUND);
        expect(result.error.message).toContain('non-existent-watch-id');
      }
    });
  });

  describe('getActiveWatches', () => {
    it('should return empty array initially', () => {
      const watches = watchService.getActiveWatches();
      expect(watches).toEqual([]);
    });
  });

  describe('stopAllWatches', () => {
    it('should return 0 when no watches active', async () => {
      const count = await watchService.stopAllWatches();
      expect(count).toBe(0);
    });
  });

  describe('watchDirectory', () => {
    it('should return error for non-existent path', async () => {
      const result = await watchService.watchDirectory(
        '/non/existent/path/12345'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.FILE_NOT_FOUND);
      }
    });
  });

  describe('parseInotifyEvent', () => {
    // Access private method for testing
    const testParseEvent = (service: WatchService, line: string) => {
      return (service as any).parseInotifyEvent(line);
    };

    it('should parse CREATE event', () => {
      const result = testParseEvent(watchService, 'CREATE|/app/file.ts|');
      expect(result).toEqual({
        eventType: 'create',
        path: '/app/file.ts',
        isDirectory: false
      });
    });

    it('should parse CREATE,ISDIR event', () => {
      const result = testParseEvent(
        watchService,
        'CREATE,ISDIR|/app/newdir|ISDIR'
      );
      expect(result).toEqual({
        eventType: 'create',
        path: '/app/newdir',
        isDirectory: true
      });
    });

    it('should parse MODIFY event', () => {
      const result = testParseEvent(watchService, 'MODIFY|/app/file.ts|');
      expect(result).toEqual({
        eventType: 'modify',
        path: '/app/file.ts',
        isDirectory: false
      });
    });

    it('should parse DELETE event', () => {
      const result = testParseEvent(watchService, 'DELETE|/app/file.ts|');
      expect(result).toEqual({
        eventType: 'delete',
        path: '/app/file.ts',
        isDirectory: false
      });
    });

    it('should parse MOVED_FROM event', () => {
      const result = testParseEvent(watchService, 'MOVED_FROM|/app/old.ts|');
      expect(result).toEqual({
        eventType: 'move_from',
        path: '/app/old.ts',
        isDirectory: false
      });
    });

    it('should parse MOVED_TO event', () => {
      const result = testParseEvent(watchService, 'MOVED_TO|/app/new.ts|');
      expect(result).toEqual({
        eventType: 'move_to',
        path: '/app/new.ts',
        isDirectory: false
      });
    });

    it('should parse CLOSE_WRITE as modify', () => {
      const result = testParseEvent(watchService, 'CLOSE_WRITE|/app/file.ts|');
      expect(result).toEqual({
        eventType: 'modify',
        path: '/app/file.ts',
        isDirectory: false
      });
    });

    it('should return null for malformed line', () => {
      expect(testParseEvent(watchService, 'invalid')).toBeNull();
      expect(testParseEvent(watchService, '')).toBeNull();
      expect(testParseEvent(watchService, '|')).toBeNull();
    });

    it('should return null for unknown event type', () => {
      const result = testParseEvent(
        watchService,
        'UNKNOWN_EVENT|/app/file.ts|'
      );
      expect(result).toBeNull();
    });
  });

  describe('buildInotifyArgs', () => {
    // Access private method for testing
    const testBuildArgs = (
      service: WatchService,
      path: string,
      options: any
    ) => {
      return (service as any).buildInotifyArgs(path, options);
    };

    it('should include monitor mode and format', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args).toContain('-m');
      expect(args).toContain('--format');
      expect(args).toContain('%e|%w%f|%:e');
    });

    it('should include recursive flag by default', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args).toContain('-r');
    });

    it('should exclude recursive flag when disabled', () => {
      const args = testBuildArgs(watchService, '/app', {
        path: '/app',
        recursive: false
      });
      expect(args).not.toContain('-r');
    });

    it('should include default excludes', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args).toContain('--exclude');
      // Default excludes: .git, node_modules, .DS_Store
      const excludeIndices = args.reduce(
        (acc: number[], arg: string, i: number) => {
          if (arg === '--exclude') acc.push(i);
          return acc;
        },
        []
      );
      expect(excludeIndices.length).toBe(3);
    });

    it('should use custom excludes when provided', () => {
      const args = testBuildArgs(watchService, '/app', {
        path: '/app',
        exclude: ['*.log', 'temp']
      });
      expect(args).toContain('--exclude');
      expect(args).toContain('*.log');
      expect(args).toContain('temp');
    });

    it('should add path as last argument', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args[args.length - 1]).toBe('/app');
    });
  });
});
