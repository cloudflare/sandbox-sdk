import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { WatchRequest } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { WatchService } from '@sandbox-container/services/watch-service';

const mockLogger = createNoOpLogger();

/**
 * Type-safe accessor for testing private WatchService methods.
 * Uses module augmentation to expose private methods for testing only.
 */
interface WatchServiceTestAccessor {
  parseInotifyEvent(line: string): {
    eventType: string;
    path: string;
    isDirectory: boolean;
  } | null;
  buildInotifyArgs(path: string, options: WatchRequest): string[];
}

describe('WatchService', () => {
  let watchService: WatchService;

  beforeEach(() => {
    vi.clearAllMocks();
    watchService = new WatchService(mockLogger);
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
    // Access private method for testing via type assertion
    const testParseEvent = (service: WatchService, line: string) => {
      return (service as unknown as WatchServiceTestAccessor).parseInotifyEvent(
        line
      );
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

    it('should parse CREATE,ISDIR with colon-separated flags from %:e format', () => {
      // This is the actual output format from inotifywait with --format '%e|%w%f|%:e'
      const result = testParseEvent(
        watchService,
        'CREATE,ISDIR|/app/newdir|CREATE:ISDIR'
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
    // Access private method for testing via type assertion
    const testBuildArgs = (
      service: WatchService,
      path: string,
      options: WatchRequest
    ) => {
      return (service as unknown as WatchServiceTestAccessor).buildInotifyArgs(
        path,
        options
      );
    };

    it('should include monitor mode and format', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args).toContain('-m');
      expect(args).toContain('--format');
      expect(args).toContain('%e|%w%f');
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

    it('should include default excludes as combined regex pattern', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args).toContain('--exclude');
      // inotifywait only supports a single --exclude, so patterns are combined with OR
      const excludeIndex = args.indexOf('--exclude');
      expect(excludeIndex).toBeGreaterThan(-1);
      const excludePattern = args[excludeIndex + 1];
      // Verify combined regex format: (^|/)pattern(/|$)|(^|/)pattern(/|$)|...
      expect(excludePattern).toContain('(^|/)\\.git(/|$)');
      expect(excludePattern).toContain('(^|/)node_modules(/|$)');
      expect(excludePattern).toContain('(^|/)\\.DS_Store(/|$)');
      // Patterns are joined with |
      expect(excludePattern.split('|').length).toBeGreaterThanOrEqual(3);
    });

    it('should convert custom excludes to combined regex pattern', () => {
      const args = testBuildArgs(watchService, '/app', {
        path: '/app',
        exclude: ['*.log', 'temp']
      });
      expect(args).toContain('--exclude');
      const excludeIndex = args.indexOf('--exclude');
      const excludePattern = args[excludeIndex + 1];
      expect(excludePattern).toContain('(^|/)[^/]*\\.log(/|$)');
      expect(excludePattern).toContain('(^|/)temp(/|$)');
    });

    it('should include include patterns when provided', () => {
      const args = testBuildArgs(watchService, '/app', {
        path: '/app',
        include: ['*.ts', 'src/**']
      });
      expect(args).toContain('--include');
      expect(args).not.toContain('--exclude');
      const includeIndex = args.indexOf('--include');
      const includePattern = args[includeIndex + 1];
      expect(includePattern).toContain('(^|/)[^/]*\\.ts(/|$)');
      expect(includePattern).toContain('(^|/)src/.*(/|$)');
    });

    it('should add path as last argument', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args[args.length - 1]).toBe('/app');
    });
  });
});
