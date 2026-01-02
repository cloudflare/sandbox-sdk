import type {
  FileWatchEventType,
  FileWatchSSEEvent,
  Logger,
  WatchRequest
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { Subprocess } from 'bun';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';

interface ActiveWatch {
  id: string;
  path: string;
  process: Subprocess;
  options: WatchRequest;
  startedAt: Date;
}

/**
 * Service for watching filesystem changes using inotifywait
 */
export class WatchService {
  private activeWatches: Map<string, ActiveWatch> = new Map();
  private watchCounter = 0;

  constructor(private logger: Logger) {}

  /**
   * Start watching a directory for changes
   * Returns a ReadableStream of SSE events
   *
   * @param path - Absolute path to watch
   * @param options - Watch options
   */
  async watchDirectory(
    path: string,
    options: WatchRequest = { path }
  ): Promise<ServiceResult<ReadableStream<Uint8Array>>> {
    const watchId = `watch-${++this.watchCounter}-${Date.now()}`;
    const watchLogger = this.logger.child({ watchId, path });

    // Verify path exists
    const pathCheck = Bun.spawnSync(['test', '-e', path]);
    if (pathCheck.exitCode !== 0) {
      return serviceError({
        message: `Path does not exist: ${path}`,
        code: ErrorCode.FILE_NOT_FOUND,
        details: { path }
      });
    }

    // Build inotifywait command
    const args = this.buildInotifyArgs(path, options);
    watchLogger.debug('Starting inotifywait', { args });

    try {
      const proc = Bun.spawn(['inotifywait', ...args], {
        stdout: 'pipe',
        stderr: 'pipe'
      });

      // Store active watch
      this.activeWatches.set(watchId, {
        id: watchId,
        path,
        process: proc,
        options,
        startedAt: new Date()
      });

      // Create SSE stream from inotifywait output
      const stream = this.createWatchStream(
        watchId,
        path,
        proc,
        options,
        watchLogger
      );

      return serviceSuccess(stream);
    } catch (error) {
      watchLogger.error('Failed to start inotifywait', error as Error);
      return serviceError({
        message: `Failed to start file watcher: ${error instanceof Error ? error.message : 'Unknown error'}`,
        code: ErrorCode.UNKNOWN_ERROR,
        details: { path }
      });
    }
  }

  /**
   * Stop a specific watch
   */
  async stopWatch(watchId: string): Promise<ServiceResult<void>> {
    const watch = this.activeWatches.get(watchId);
    if (!watch) {
      return serviceError({
        message: `Watch not found: ${watchId}`,
        code: ErrorCode.UNKNOWN_ERROR,
        details: { watchId }
      });
    }

    try {
      watch.process.kill();
      this.activeWatches.delete(watchId);
      this.logger.info('Watch stopped', { watchId, path: watch.path });
      return serviceSuccess(undefined);
    } catch (error) {
      return serviceError({
        message: `Failed to stop watch: ${error instanceof Error ? error.message : 'Unknown error'}`,
        code: ErrorCode.UNKNOWN_ERROR,
        details: { watchId }
      });
    }
  }

  /**
   * Stop all active watches
   */
  async stopAllWatches(): Promise<number> {
    let count = 0;
    for (const [watchId, watch] of this.activeWatches) {
      try {
        watch.process.kill();
        count++;
      } catch {
        this.logger.warn('Failed to kill watch process', { watchId });
      }
    }
    this.activeWatches.clear();
    return count;
  }

  /**
   * Get list of active watches
   */
  getActiveWatches(): Array<{ id: string; path: string; startedAt: Date }> {
    return Array.from(this.activeWatches.values()).map((w) => ({
      id: w.id,
      path: w.path,
      startedAt: w.startedAt
    }));
  }

  private buildInotifyArgs(path: string, options: WatchRequest): string[] {
    const args: string[] = [
      '-m', // Monitor mode (continuous)
      '--format',
      '%e|%w%f|%:e' // event|path|is_dir
    ];

    // Recursive watching
    if (options.recursive !== false) {
      args.push('-r');
    }

    // Event types
    const events: FileWatchEventType[] = options.events || [
      'create',
      'modify',
      'delete',
      'move_from',
      'move_to'
    ];
    const inotifyEvents = events
      .map((e) => this.mapEventType(e))
      .filter((e): e is string => e !== undefined);
    if (inotifyEvents.length > 0) {
      args.push('-e', inotifyEvents.join(','));
    }

    // Exclude patterns
    const excludes = options.exclude || ['.git', 'node_modules', '.DS_Store'];
    for (const pattern of excludes) {
      args.push('--exclude', pattern);
    }

    // Add path last
    args.push(path);

    return args;
  }

  private mapEventType(type: FileWatchEventType): string | undefined {
    const mapping: Record<FileWatchEventType, string> = {
      create: 'create',
      modify: 'modify',
      delete: 'delete',
      move_from: 'moved_from',
      move_to: 'moved_to',
      attrib: 'attrib'
    };
    return mapping[type];
  }

  private parseInotifyEvent(line: string): {
    eventType: FileWatchEventType;
    path: string;
    isDirectory: boolean;
  } | null {
    // Format: EVENT|/path/to/file|ISDIR (or empty if not dir)
    const parts = line.trim().split('|');
    if (parts.length < 2) return null;

    const [rawEvent, filePath, isDirFlag] = parts;
    const isDirectory = isDirFlag === 'ISDIR';

    // Map inotify event back to our type
    const eventType = this.parseEventType(rawEvent);
    if (!eventType) return null;

    return { eventType, path: filePath, isDirectory };
  }

  private parseEventType(rawEvent: string): FileWatchEventType | null {
    // inotify can emit multiple events like "CREATE,ISDIR"
    const events = rawEvent.split(',');
    const primary = events[0].toLowerCase();

    const mapping: Record<string, FileWatchEventType> = {
      create: 'create',
      modify: 'modify',
      delete: 'delete',
      moved_from: 'move_from',
      moved_to: 'move_to',
      attrib: 'attrib',
      // Handle close_write as modify (common for editors)
      close_write: 'modify'
    };

    return mapping[primary] || null;
  }

  private createWatchStream(
    watchId: string,
    path: string,
    proc: Subprocess,
    options: WatchRequest,
    logger: Logger
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const includePatterns = options.include;
    const self = this;
    const stdout = proc.stdout;

    if (!stdout || typeof stdout === 'number') {
      // Return a stream that immediately errors
      return new ReadableStream({
        start(controller) {
          const errorEvent: FileWatchSSEEvent = {
            type: 'error',
            error: 'Failed to capture process output'
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
          controller.close();
        }
      });
    }

    return new ReadableStream({
      async start(controller) {
        // Send initial watching event
        const watchingEvent: FileWatchSSEEvent = {
          type: 'watching',
          path,
          watchId
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(watchingEvent)}\n\n`)
        );

        // Read stdout line by line
        const reader = stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const processLine = (line: string) => {
          const parsed = self.parseInotifyEvent(line);
          if (!parsed) return;

          // Apply include filter if specified
          if (includePatterns && includePatterns.length > 0) {
            const matches = includePatterns.some((pattern: string) =>
              self.matchGlob(parsed.path, pattern)
            );
            if (!matches) return;
          }

          const event: FileWatchSSEEvent = {
            type: 'event',
            eventType: parsed.eventType,
            path: parsed.path,
            isDirectory: parsed.isDirectory,
            timestamp: new Date().toISOString()
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim()) {
                processLine(line);
              }
            }
          }

          // Process any remaining buffer
          if (buffer.trim()) {
            processLine(buffer);
          }

          // Send stopped event
          const stoppedEvent: FileWatchSSEEvent = {
            type: 'stopped',
            reason: 'Watch process ended'
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(stoppedEvent)}\n\n`)
          );
          controller.close();
        } catch (error) {
          logger.error('Error reading watch output', error as Error);
          const errorEvent: FileWatchSSEEvent = {
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
          controller.close();
        } finally {
          self.activeWatches.delete(watchId);
        }
      },

      cancel() {
        // Clean up when stream is cancelled
        proc.kill();
        self.activeWatches.delete(watchId);
        logger.info('Watch cancelled', { watchId });
      }
    });
  }

  /**
   * Simple glob matching for include patterns
   */
  private matchGlob(path: string, pattern: string): boolean {
    // Convert glob to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    // Check if pattern matches the filename or path
    const regex = new RegExp(regexPattern);
    const filename = path.split('/').pop() || '';
    return regex.test(filename) || regex.test(path);
  }
}
