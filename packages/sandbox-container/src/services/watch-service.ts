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
      const err = error instanceof Error ? error : new Error(String(error));
      watchLogger.error('Failed to start inotifywait', err);
      return serviceError({
        message: `Failed to start file watcher: ${error instanceof Error ? error.message : 'Unknown error'}`,
        code: ErrorCode.WATCH_START_ERROR,
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
        code: ErrorCode.WATCH_NOT_FOUND,
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
      } catch (error) {
        // Log the actual error for debugging
        // Expected case: process already exited (no longer running)
        // Unexpected: permission errors, system issues
        this.logger.warn('Failed to kill watch process', {
          watchId,
          error: error instanceof Error ? error.message : String(error),
          path: watch.path
        });
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
      '%e|%w%f' // event|path (ISDIR is part of event flags)
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

    // Exclude patterns - convert to regex for inotifywait
    // inotifywait --exclude uses POSIX extended regex matching against full path
    // NOTE: inotifywait only supports a single --exclude option, so we combine all patterns
    const excludes = options.exclude || ['.git', 'node_modules', '.DS_Store'];
    if (excludes.length > 0) {
      // Escape regex metacharacters and wrap each pattern to match anywhere in path
      const escapedPatterns = excludes.map((pattern) => {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return `(^|/)${escaped}(/|$)`;
      });
      // Combine all patterns with OR operator
      args.push('--exclude', escapedPatterns.join('|'));
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
    // Format: EVENT|/path/to/file|EVENT_FLAGS
    // The third part (%:e) contains colon-separated flags like CREATE:ISDIR
    const parts = line.trim().split('|');
    if (parts.length < 2) return null;

    const [rawEvent, filePath, flagsPart] = parts;
    // Check if ISDIR appears in either the event or the flags
    const isDirectory =
      rawEvent.includes('ISDIR') || (flagsPart?.includes('ISDIR') ?? false);

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
    const stderr = proc.stderr;

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
        // Wait for inotifywait to establish watches before sending watching event
        // This ensures clients know the watch is truly ready to detect changes
        if (stderr && typeof stderr !== 'number') {
          await self.waitForWatchesEstablished(
            stderr,
            controller,
            encoder,
            logger
          );
        }

        // Send watching event only after watches are established
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
          logger.debug('Starting to read inotifywait stdout');
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              logger.debug('inotifywait stdout stream ended');
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            logger.debug('Received chunk from inotifywait', {
              chunkLength: chunk.length,
              chunk: chunk.substring(0, 200)
            });
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim()) {
                logger.debug('Processing inotifywait line', { line });
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
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error('Error reading watch output', err);
          const errorEvent: FileWatchSSEEvent = {
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
          controller.close();
        } finally {
          // Ensure process is killed on any exit path
          try {
            proc.kill();
          } catch {
            // Process may already be dead
          }
          self.activeWatches.delete(watchId);
        }
      },

      cancel() {
        // Clean up when stream is cancelled
        try {
          proc.kill();
        } catch (error) {
          logger.warn('Failed to kill watch process on cancel', {
            watchId,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
        self.activeWatches.delete(watchId);
        logger.info('Watch cancelled', { watchId });
      }
    });
  }

  /**
   * Wait for inotifywait to output "Watches established" on stderr.
   * This ensures the watch is ready to detect file changes before we signal readiness to clients.
   * After watches are established, continues monitoring stderr for errors in background.
   *
   * Has a timeout to prevent hanging if inotifywait behaves unexpectedly.
   */
  private async waitForWatchesEstablished(
    stderr: ReadableStream<Uint8Array>,
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    logger: Logger
  ): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let established = false;

    // Timeout after 10 seconds - inotifywait should establish watches quickly
    const timeoutMs = 10000;
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs)
    );

    const readLoop = async (): Promise<'done' | 'established'> => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            logger.debug('stderr ended before watches established');
            return 'done';
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              if (trimmed.includes('Watches established')) {
                logger.debug('inotifywait watches established');
                established = true;
                return 'established';
              }
              if (trimmed.includes('Setting up watches')) {
                logger.debug('inotifywait setting up watches', {
                  message: trimmed
                });
                continue;
              }
              // Actual error from inotifywait
              logger.warn('inotifywait stderr during setup', {
                message: trimmed
              });
              const errorEvent: FileWatchSSEEvent = {
                type: 'error',
                error: trimmed
              };
              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
                );
              } catch {
                // Controller may be closed
                return 'done';
              }
            }
          }
        }
      } catch (error) {
        logger.debug('stderr reading ended during setup', {
          error: error instanceof Error ? error.message : 'Unknown'
        });
        return 'done';
      }
    };

    const result = await Promise.race([readLoop(), timeoutPromise]);

    if (result === 'timeout') {
      logger.warn('Timeout waiting for inotifywait to establish watches');
      // Continue anyway - watches might still work
    }

    if (established) {
      // Continue monitoring stderr for errors in background
      this.continueStderrMonitoring(
        reader,
        decoder,
        buffer,
        controller,
        encoder,
        logger
      );
    } else {
      // Release the reader if we're not continuing to monitor
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released
      }
    }
  }

  /**
   * Continue monitoring stderr for errors after watches are established.
   * Runs in background without blocking.
   */
  private continueStderrMonitoring(
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
    decoder: TextDecoder,
    initialBuffer: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    logger: Logger
  ): void {
    (async () => {
      let buffer = initialBuffer;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              // Skip info messages
              if (
                trimmed.includes('Watches established') ||
                trimmed.includes('Setting up watches')
              ) {
                logger.debug('inotifywait info', { message: trimmed });
                continue;
              }

              logger.warn('inotifywait stderr', { message: trimmed });
              const errorEvent: FileWatchSSEEvent = {
                type: 'error',
                error: trimmed
              };
              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
                );
              } catch {
                // Controller may be closed
                break;
              }
            }
          }
        }
      } catch (error) {
        // Stream closed or other error - expected when process terminates
        logger.debug('stderr monitoring ended', {
          error: error instanceof Error ? error.message : 'Unknown'
        });
      }
    })();
  }

  /**
   * Simple glob matching for include patterns
   * Converts glob pattern to regex character-by-character for security
   */
  private matchGlob(filePath: string, pattern: string): boolean {
    const regexParts: string[] = ['^'];

    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];

      switch (char) {
        case '*':
          // ** matches any path segments, * matches any chars except /
          if (pattern[i + 1] === '*') {
            regexParts.push('.*');
            i++; // Skip next *
          } else {
            regexParts.push('[^/]*');
          }
          break;
        case '?':
          // ? matches single char except /
          regexParts.push('[^/]');
          break;
        case '.':
        case '+':
        case '^':
        case '$':
        case '{':
        case '}':
        case '(':
        case ')':
        case '|':
        case '\\':
          // Escape regex metacharacters
          regexParts.push(`\\${char}`);
          break;
        case '[':
          // Character classes - find matching ] and treat literally
          // to prevent [a-z] from being interpreted as regex range
          regexParts.push('\\[');
          break;
        case ']':
          regexParts.push('\\]');
          break;
        default:
          regexParts.push(char);
      }
    }

    regexParts.push('$');
    const regex = new RegExp(regexParts.join(''));

    // Match against filename only (for patterns like *.ts)
    const filename = filePath.split('/').pop() || '';
    return regex.test(filename);
  }
}
