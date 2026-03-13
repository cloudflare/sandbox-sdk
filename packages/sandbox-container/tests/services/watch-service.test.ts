import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { WatchRequest, WatchState } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { WatchService } from '@sandbox-container/services/watch-service';

const mockLogger = createNoOpLogger();

interface FakeWatchProcess {
  exited: Promise<number>;
  kill: ReturnType<typeof vi.fn>;
}

interface WatchServiceTestAccessor {
  activeWatches: Map<string, unknown>;
  watchIdsByKey: Map<string, string>;
  createWatchKey(
    path: string,
    options: {
      recursive: boolean;
      include?: string[];
      exclude?: string[];
      events: string[];
    }
  ): string;
  parseInotifyEvent(line: string): {
    eventType: string;
    path: string;
    isDirectory: boolean;
  } | null;
  buildInotifyArgs(path: string, options: WatchRequest): string[];
}

function makeWatchState(overrides: Partial<WatchState> = {}): WatchState {
  return {
    watchId: 'watch-1',
    path: '/workspace/test',
    recursive: true,
    include: undefined,
    exclude: ['.git'],
    cursor: 0,
    changed: false,
    overflowed: false,
    lastEventAt: null,
    expiresAt: null,
    subscriberCount: 0,
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

function makeFakeProcess(): FakeWatchProcess {
  return {
    exited: Promise.resolve(0),
    kill: vi.fn()
  };
}

function makeActiveWatch(overrides: Partial<Record<string, unknown>> = {}) {
  const state = makeWatchState(
    (overrides.state as Partial<WatchState> | undefined) ?? {}
  );
  const process =
    (overrides.process as FakeWatchProcess | undefined) ?? makeFakeProcess();

  return {
    id: state.watchId,
    key: 'watch-key',
    path: state.path,
    recursive: state.recursive,
    include: state.include,
    exclude: state.exclude,
    process,
    startedAt: new Date(state.startedAt),
    leaseToken:
      (overrides.leaseToken as string | null | undefined) ?? 'lease-1',
    state,
    persistent: true,
    subscribers: new Map(),
    ready: {
      promise: Promise.resolve(),
      resolve: () => {},
      reject: () => {}
    },
    readyState: 'resolved',
    expiryTimer: null,
    ...overrides
  };
}

describe('WatchService', () => {
  let watchService: WatchService;
  let accessor: WatchServiceTestAccessor;

  beforeEach(() => {
    vi.clearAllMocks();
    watchService = new WatchService(mockLogger);
    accessor = watchService as unknown as WatchServiceTestAccessor;
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

  describe('watch state management', () => {
    it('should return not found for unknown watch state', async () => {
      const result = await watchService.getWatchState('missing-watch');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.WATCH_NOT_FOUND);
      }
    });

    it('should clear changed state only when checkpoint cursor matches', async () => {
      const watch = makeActiveWatch({
        state: { cursor: 7, changed: true, overflowed: true }
      });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set('watch-key', 'watch-1');

      const result = await watchService.checkpointWatch(
        'watch-1',
        7,
        'lease-1'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.checkpointed).toBe(true);
        expect(result.data.watch.changed).toBe(false);
        expect(result.data.watch.overflowed).toBe(false);
      }
    });

    it('should keep changed state when checkpoint cursor is stale', async () => {
      const watch = makeActiveWatch({
        state: { cursor: 8, changed: true, overflowed: true }
      });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set('watch-key', 'watch-1');

      const result = await watchService.checkpointWatch(
        'watch-1',
        7,
        'lease-1'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.checkpointed).toBe(false);
        expect(result.data.watch.changed).toBe(true);
        expect(result.data.watch.overflowed).toBe(true);
      }
    });

    it('should reject checkpoint from a different lease token', async () => {
      const watch = makeActiveWatch({
        state: { cursor: 8, changed: true },
        leaseToken: 'lease-1'
      });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set('watch-key', 'watch-1');

      const result = await watchService.checkpointWatch(
        'watch-1',
        8,
        'lease-2'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.RESOURCE_BUSY);
      }
    });

    it('should reject checkpoint for non-persistent watches', async () => {
      const watch = makeActiveWatch({
        persistent: false,
        leaseToken: null
      });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set('watch-key', 'watch-1');

      const result = await watchService.checkpointWatch(
        'watch-1',
        8,
        'lease-1'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.RESOURCE_BUSY);
      }
    });

    it('should require leaseToken when stopping a leased watch', async () => {
      const process = makeFakeProcess();
      const watch = makeActiveWatch({
        process
      });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set('watch-key', 'watch-1');

      const result = await watchService.stopWatch('watch-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.RESOURCE_BUSY);
      }
      expect(process.kill).not.toHaveBeenCalled();
    });

    it('should refresh persistent watch expiry on read', async () => {
      const watch = makeActiveWatch({ state: { expiresAt: null } });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set('watch-key', 'watch-1');

      const result = await watchService.getWatchState('watch-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.expiresAt).toBe('string');
      }
    });

    it('should return the same lease token when reusing a persistent watch', async () => {
      const watch = makeActiveWatch({
        leaseToken: 'lease-1',
        resumeToken: 'resume-1'
      });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set(
        accessor.createWatchKey('/workspace/test', {
          recursive: true,
          include: undefined,
          exclude: undefined,
          events: ['create', 'modify', 'delete', 'move_from', 'move_to']
        }),
        'watch-1'
      );

      const result = await watchService.ensureWatch('/workspace/test', {
        path: '/workspace/test',
        resumeToken: 'resume-1'
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.leaseToken).toBe('lease-1');
      }
    });

    it('should reject reusing a persistent watch without the same resume token', async () => {
      const watch = makeActiveWatch({
        leaseToken: 'lease-1',
        resumeToken: 'resume-1'
      });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set(
        accessor.createWatchKey('/workspace/test', {
          recursive: true,
          include: undefined,
          exclude: undefined,
          events: ['create', 'modify', 'delete', 'move_from', 'move_to']
        }),
        'watch-1'
      );

      const result = await watchService.ensureWatch('/workspace/test', {
        path: '/workspace/test'
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(ErrorCode.RESOURCE_BUSY);
      }
    });

    it('should stop an active watch and clean up indexes', async () => {
      const process = makeFakeProcess();
      const watch = makeActiveWatch({ process });
      accessor.activeWatches.set('watch-1', watch);
      accessor.watchIdsByKey.set('watch-key', 'watch-1');

      const result = await watchService.stopWatch('watch-1', 'lease-1');

      expect(result.success).toBe(true);
      expect(process.kill).toHaveBeenCalled();
      expect(accessor.activeWatches.has('watch-1')).toBe(false);
      expect(accessor.watchIdsByKey.has('watch-key')).toBe(false);
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
    const testCreateWatchKey = (
      service: WatchService,
      path: string,
      options: WatchRequest
    ) => {
      return (service as unknown as WatchServiceTestAccessor).createWatchKey(
        path,
        {
          recursive: options.recursive !== false,
          include: options.include,
          exclude: options.exclude,
          events: options.events ?? [
            'create',
            'modify',
            'delete',
            'move_from',
            'move_to'
          ]
        }
      );
    };

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
      const excludeIndex = args.indexOf('--exclude');
      expect(excludeIndex).toBeGreaterThan(-1);
      const excludePattern = args[excludeIndex + 1];
      expect(excludePattern).toContain('(^|/)\\.git(/|$)');
      expect(excludePattern).toContain('(^|/)node_modules(/|$)');
      expect(excludePattern).toContain('(^|/)\\.DS_Store(/|$)');
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

    it('should treat empty include arrays like no include filter', () => {
      const args = testBuildArgs(watchService, '/app', {
        path: '/app',
        include: [],
        exclude: ['tmp']
      });
      expect(args).not.toContain('--include');
      expect(args).toContain('--exclude');
      const excludeIndex = args.indexOf('--exclude');
      expect(args[excludeIndex + 1]).toContain('(^|/)tmp(/|$)');
    });

    it('should include event filters in the watch key', () => {
      const createOnlyKey = testCreateWatchKey(watchService, '/app', {
        path: '/app',
        events: ['create']
      });
      const modifyOnlyKey = testCreateWatchKey(watchService, '/app', {
        path: '/app',
        events: ['modify']
      });

      expect(createOnlyKey).not.toBe(modifyOnlyKey);
    });

    it('should normalize event order in the watch key', () => {
      const firstKey = testCreateWatchKey(watchService, '/app', {
        path: '/app',
        events: ['create', 'modify']
      });
      const secondKey = testCreateWatchKey(watchService, '/app', {
        path: '/app',
        events: ['modify', 'create']
      });

      expect(firstKey).toBe(secondKey);
    });

    it('should normalize include pattern order in the watch key', () => {
      const firstKey = testCreateWatchKey(watchService, '/app', {
        path: '/app',
        include: ['*.ts', 'src/**']
      });
      const secondKey = testCreateWatchKey(watchService, '/app', {
        path: '/app',
        include: ['src/**', '*.ts']
      });

      expect(firstKey).toBe(secondKey);
    });

    it('should add path as last argument', () => {
      const args = testBuildArgs(watchService, '/app', { path: '/app' });
      expect(args[args.length - 1]).toBe('/app');
    });
  });
});
