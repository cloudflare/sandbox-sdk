import type {
  CheckChangesRequest,
  CheckChangesResult,
  FileWatchEventType,
  FileWatchSSEEvent,
  Logger,
  WatchRequest
} from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { Subprocess } from 'bun';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

type LiveWatchEvent = Extract<FileWatchSSEEvent, { type: 'event' }>;
type TerminalWatchEvent = Extract<
  FileWatchSSEEvent,
  { type: 'error' | 'stopped' }
>;

interface WatchSubscriber {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  pendingEvents: Map<string, LiveWatchEvent>;
  droppedEvents: number;
  flushInterval: ReturnType<typeof setInterval>;
  watchingSent: boolean;
  closed: boolean;
}

interface ActiveWatch {
  id: string;
  key: string;
  path: string;
  recursive: boolean;
  include?: string[];
  exclude?: string[];
  process: Subprocess;
  startedAt: Date;
  retained: boolean;
  cursor: number;
  lastEventAt: string | null;
  expiresAt: string | null;
  subscribers: Map<string, WatchSubscriber>;
  ready: Deferred<void>;
  readyState: 'pending' | 'resolved' | 'rejected';
  expiryTimer: ReturnType<typeof setTimeout> | null;
  stopPromise?: Promise<void>;
}

const WATCH_SETUP_TIMEOUT_MS = 10000;
const EVENT_COALESCE_WINDOW_MS = 75;
const MAX_PENDING_EVENTS = 1000;
const CHANGE_STATE_IDLE_TTL_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 5000;
const DEFAULT_EXCLUDE_PATTERNS = ['.git', 'node_modules', '.DS_Store'];
const DEFAULT_WATCH_EVENTS: FileWatchEventType[] = [
  'create',
  'modify',
  'delete',
  'move_from',
  'move_to'
];

/**
 * Service for watching filesystem changes using inotifywait.
 */
export class WatchService {
  private activeWatches: Map<string, ActiveWatch> = new Map();
  private watchIdsByKey: Map<string, string> = new Map();
  private watchCounter = 0;
  private subscriberCounter = 0;

  constructor(private logger: Logger) {}

  /**
   * Start watching a directory and subscribe to live events.
   */
  async watchDirectory(
    path: string,
    options: WatchRequest = { path }
  ): Promise<ServiceResult<ReadableStream<Uint8Array>>> {
    const watchResult = this.getOrCreateWatch(path, options);
    if (!watchResult.success) {
      return serviceError(watchResult.error);
    }

    return serviceSuccess(this.createSubscriberStream(watchResult.data.watch));
  }

  /**
   * Check whether a path changed since a previously returned version.
   */
  async checkChanges(
    path: string,
    options: CheckChangesRequest = { path }
  ): Promise<ServiceResult<CheckChangesResult>> {
    const watchResult = this.getOrCreateWatch(path, options);
    if (!watchResult.success) {
      return serviceError(watchResult.error);
    }

    const { watch, created } = watchResult.data;
    watch.retained = true;

    try {
      await watch.ready.promise;
      this.refreshRetainedWatchExpiry(watch);
      return this.buildCheckChangesResult(watch, options.since, created);
    } catch (error) {
      return serviceError({
        message:
          error instanceof Error
            ? error.message
            : 'Failed to establish retained change state',
        code: ErrorCode.WATCH_START_ERROR,
        details: { path }
      });
    }
  }

  /**
   * Stop all active watches.
   */
  async stopAllWatches(): Promise<number> {
    const watchIds = Array.from(this.activeWatches.keys());
    await Promise.all(watchIds.map((id) => this.stopWatchInternal(id)));
    return watchIds.length;
  }

  /**
   * Get list of active watches.
   */
  getActiveWatches(): Array<{ id: string; path: string; startedAt: Date }> {
    return Array.from(this.activeWatches.values()).map((watch) => ({
      id: watch.id,
      path: watch.path,
      startedAt: watch.startedAt
    }));
  }

  private getOrCreateWatch(
    path: string,
    options: WatchRequest
  ): ServiceResult<{ watch: ActiveWatch; created: boolean }> {
    const normalized = this.normalizeWatchOptions(options);
    const key = this.createWatchKey(path, normalized);
    const existingWatchId = this.watchIdsByKey.get(key);

    if (existingWatchId) {
      const existing = this.activeWatches.get(existingWatchId);
      if (
        existing &&
        !existing.stopPromise &&
        existing.readyState !== 'rejected'
      ) {
        return serviceSuccess({ watch: existing, created: false });
      }
      this.activeWatches.delete(existingWatchId);
      this.watchIdsByKey.delete(key);
    }

    const pathCheck = Bun.spawnSync(['test', '-e', path]);
    if (pathCheck.exitCode !== 0) {
      return serviceError({
        message: `Path does not exist: ${path}`,
        code: ErrorCode.FILE_NOT_FOUND,
        details: { path }
      });
    }

    const watchId = `watch-${++this.watchCounter}-${Date.now()}`;
    const args = this.buildInotifyArgs(path, options);
    const startTime = Date.now();

    try {
      const proc = Bun.spawn(['inotifywait', ...args], {
        stdout: 'pipe',
        stderr: 'pipe'
      });

      const watch: ActiveWatch = {
        id: watchId,
        key,
        path,
        recursive: normalized.recursive,
        include: normalized.include,
        exclude: normalized.exclude,
        process: proc,
        startedAt: new Date(),
        retained: false,
        cursor: 0,
        lastEventAt: null,
        expiresAt: null,
        subscribers: new Map(),
        ready: createDeferred<void>(),
        readyState: 'pending',
        expiryTimer: null
      };

      this.activeWatches.set(watchId, watch);
      this.watchIdsByKey.set(key, watchId);

      const watchLogger = this.logger.child({ watchId, path });
      this.runWatchLoop(watch, watchLogger, startTime);

      return serviceSuccess({ watch, created: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logCanonicalEvent(this.logger, {
        event: 'watch.start',
        outcome: 'error',
        durationMs: Date.now() - startTime,
        path,
        watchId,
        errorMessage: err.message,
        error: err
      });
      return serviceError({
        message: `Failed to start file watcher: ${err.message}`,
        code: ErrorCode.WATCH_START_ERROR,
        details: { path }
      });
    }
  }

  private normalizeWatchOptions(options: WatchRequest): {
    recursive: boolean;
    include?: string[];
    exclude?: string[];
    events: FileWatchEventType[];
  } {
    const include = this.normalizePatterns(options.include);
    const exclude = include
      ? undefined
      : (this.normalizePatterns(options.exclude) ?? DEFAULT_EXCLUDE_PATTERNS);

    return {
      recursive: options.recursive !== false,
      include,
      exclude,
      events: this.normalizeEvents(options.events)
    };
  }

  private createWatchKey(
    path: string,
    options: {
      recursive: boolean;
      include?: string[];
      exclude?: string[];
      events: FileWatchEventType[];
    }
  ): string {
    return JSON.stringify({
      path,
      recursive: options.recursive,
      include: options.include ?? null,
      exclude: options.exclude ?? null,
      events: options.events
    });
  }

  private buildCheckChangesResult(
    watch: ActiveWatch,
    since: string | undefined,
    created: boolean
  ): ServiceResult<CheckChangesResult> {
    const version = this.buildVersionToken(watch);
    const timestamp = new Date().toISOString();

    if (since === undefined) {
      return serviceSuccess({
        success: true,
        status: 'unchanged',
        version,
        timestamp
      });
    }

    const parsedVersion = this.parseVersionToken(since);
    if (!parsedVersion) {
      return serviceError({
        message: 'since must be a version returned by checkChanges()',
        code: ErrorCode.VALIDATION_FAILED,
        details: { since }
      });
    }

    if (parsedVersion.watchId !== watch.id) {
      return serviceSuccess({
        success: true,
        status: 'resync',
        reason: created ? 'expired' : 'restarted',
        version,
        timestamp
      });
    }

    if (parsedVersion.cursor > watch.cursor) {
      return serviceError({
        message: 'since refers to a newer version than the current watch state',
        code: ErrorCode.VALIDATION_FAILED,
        details: {
          since,
          currentVersion: version
        }
      });
    }

    return serviceSuccess({
      success: true,
      status: parsedVersion.cursor === watch.cursor ? 'unchanged' : 'changed',
      version,
      timestamp
    });
  }

  private buildVersionToken(watch: ActiveWatch): string {
    return `${watch.id}:${watch.cursor}`;
  }

  private parseVersionToken(
    version: string
  ): { watchId: string; cursor: number } | null {
    const separatorIndex = version.lastIndexOf(':');
    if (separatorIndex <= 0 || separatorIndex === version.length - 1) {
      return null;
    }

    const watchId = version.slice(0, separatorIndex);
    const cursorText = version.slice(separatorIndex + 1);
    if (!/^\d+$/.test(cursorText)) {
      return null;
    }

    const cursor = Number(cursorText);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return null;
    }

    return { watchId, cursor };
  }

  private refreshRetainedWatchExpiry(watch: ActiveWatch): void {
    if (!watch.retained) {
      watch.expiresAt = null;
      this.clearRetainedWatchExpiry(watch);
      return;
    }

    this.clearRetainedWatchExpiry(watch);

    if (watch.subscribers.size > 0) {
      watch.expiresAt = null;
      return;
    }

    const expiresAt = new Date(Date.now() + CHANGE_STATE_IDLE_TTL_MS);
    watch.expiresAt = expiresAt.toISOString();
    watch.expiryTimer = setTimeout(() => {
      void this.stopWatchInternal(watch.id, {
        type: 'stopped',
        reason: 'Retained change state expired after idle period'
      });
    }, CHANGE_STATE_IDLE_TTL_MS);
  }

  private clearRetainedWatchExpiry(watch: ActiveWatch): void {
    if (watch.expiryTimer) {
      clearTimeout(watch.expiryTimer);
      watch.expiryTimer = null;
    }
  }

  private createSubscriberStream(
    watch: ActiveWatch
  ): ReadableStream<Uint8Array> {
    const self = this;
    const encoder = new TextEncoder();
    let subscriberId: string | undefined;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        subscriberId = self.addSubscriber(watch, controller, encoder);

        try {
          await watch.ready.promise;
        } catch (error) {
          self.closeSubscriber(
            watch,
            subscriberId,
            errorEvent(
              error instanceof Error
                ? error.message
                : 'Watch failed to establish'
            )
          );
          return;
        }

        const subscriber = subscriberId
          ? watch.subscribers.get(subscriberId)
          : undefined;
        if (!subscriber || subscriber.closed) {
          return;
        }

        subscriber.watchingSent = true;
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'watching',
                path: watch.path,
                watchId: watch.id
              } satisfies FileWatchSSEEvent)}\n\n`
            )
          );
        } catch {
          await self.removeSubscriber(watch, subscriber.id);
          return;
        }

        self.flushSubscriberEvents(watch, subscriber);
      },

      cancel() {
        if (subscriberId) {
          return self.removeSubscriber(watch, subscriberId);
        }
        return Promise.resolve();
      }
    });
  }

  private addSubscriber(
    watch: ActiveWatch,
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder
  ): string {
    const subscriberId = `subscriber-${++this.subscriberCounter}`;
    const subscriber: WatchSubscriber = {
      id: subscriberId,
      controller,
      encoder,
      pendingEvents: new Map(),
      droppedEvents: 0,
      flushInterval: setInterval(() => {
        this.flushSubscriberEvents(watch, subscriber);
      }, EVENT_COALESCE_WINDOW_MS),
      watchingSent: false,
      closed: false
    };

    watch.subscribers.set(subscriberId, subscriber);
    this.refreshRetainedWatchExpiry(watch);
    return subscriberId;
  }

  private async removeSubscriber(
    watch: ActiveWatch,
    subscriberId: string
  ): Promise<void> {
    this.closeSubscriber(watch, subscriberId);
    await this.maybeStopWatchWhenUnused(watch);
  }

  private async maybeStopWatchWhenUnused(watch: ActiveWatch): Promise<void> {
    if (!watch.retained && watch.subscribers.size === 0) {
      await this.stopWatchInternal(watch.id, {
        type: 'stopped',
        reason: 'Watch stopped after last subscriber disconnected'
      });
      return;
    }

    this.refreshRetainedWatchExpiry(watch);
  }

  private closeSubscriber(
    watch: ActiveWatch,
    subscriberId: string,
    terminalEvent?: TerminalWatchEvent
  ): void {
    const subscriber = watch.subscribers.get(subscriberId);
    if (!subscriber || subscriber.closed) {
      return;
    }

    subscriber.closed = true;
    clearInterval(subscriber.flushInterval);
    watch.subscribers.delete(subscriberId);

    try {
      const shouldSendTerminalEvent =
        terminalEvent !== undefined &&
        (subscriber.watchingSent || terminalEvent.type === 'error');
      if (shouldSendTerminalEvent) {
        subscriber.controller.enqueue(
          subscriber.encoder.encode(
            `data: ${JSON.stringify(terminalEvent)}\n\n`
          )
        );
      }
    } catch {
      // Stream already closed.
    }

    try {
      subscriber.controller.close();
    } catch {
      // Stream already closed.
    }
  }

  private enqueueSubscriberEvent(
    watch: ActiveWatch,
    subscriber: WatchSubscriber,
    event: LiveWatchEvent
  ): void {
    if (subscriber.closed) {
      return;
    }

    const key = `${event.eventType}|${event.path}|${event.isDirectory}`;

    if (
      !subscriber.pendingEvents.has(key) &&
      subscriber.pendingEvents.size >= MAX_PENDING_EVENTS
    ) {
      subscriber.droppedEvents++;

      if (
        subscriber.droppedEvents === 1 ||
        subscriber.droppedEvents % 100 === 0
      ) {
        this.logger.warn('Dropping watch events due to backpressure', {
          watchId: watch.id,
          subscriberId: subscriber.id,
          droppedEvents: subscriber.droppedEvents,
          pendingCount: subscriber.pendingEvents.size
        });
      }
      return;
    }

    subscriber.pendingEvents.set(key, event);
  }

  private flushSubscriberEvents(
    watch: ActiveWatch,
    subscriber: WatchSubscriber
  ): void {
    if (subscriber.closed || !subscriber.watchingSent) {
      return;
    }

    try {
      for (const event of subscriber.pendingEvents.values()) {
        subscriber.controller.enqueue(
          subscriber.encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      subscriber.pendingEvents.clear();
    } catch {
      subscriber.closed = true;
      clearInterval(subscriber.flushInterval);
      watch.subscribers.delete(subscriber.id);
      void this.maybeStopWatchWhenUnused(watch);
    }
  }

  private broadcastEvent(watch: ActiveWatch, event: LiveWatchEvent): void {
    for (const subscriber of watch.subscribers.values()) {
      this.enqueueSubscriberEvent(watch, subscriber, event);
    }
  }

  private broadcastTerminalEvent(
    watch: ActiveWatch,
    terminalEvent: TerminalWatchEvent
  ): void {
    for (const subscriberId of Array.from(watch.subscribers.keys())) {
      this.closeSubscriber(watch, subscriberId, terminalEvent);
    }
  }

  private async stopWatchInternal(
    watchId: string,
    terminalEvent?: TerminalWatchEvent
  ): Promise<void> {
    const watch = this.activeWatches.get(watchId);
    if (!watch) {
      return;
    }

    if (watch.stopPromise) {
      return watch.stopPromise;
    }

    const cleanup = async () => {
      const resolvedTerminalEvent: TerminalWatchEvent = terminalEvent ?? {
        type: 'stopped',
        reason: 'Watch process ended'
      };
      const isError = resolvedTerminalEvent.type === 'error';
      const reason = isError
        ? resolvedTerminalEvent.error
        : resolvedTerminalEvent.reason;

      this.activeWatches.delete(watchId);
      this.watchIdsByKey.delete(watch.key);
      this.clearRetainedWatchExpiry(watch);

      if (watch.readyState === 'pending') {
        this.rejectWatchReady(watch, new Error(reason));
      }

      this.broadcastTerminalEvent(watch, resolvedTerminalEvent);

      try {
        watch.process.kill();
      } catch {
        // Process may have already exited.
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const exitedCleanly = await Promise.race([
        watch.process.exited.then(() => true as const),
        new Promise<false>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        })
      ]);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (!exitedCleanly) {
        try {
          watch.process.kill(9);
        } catch {
          // Process may have already exited.
        }
      }

      logCanonicalEvent(this.logger, {
        event: 'watch.stop',
        outcome: isError ? 'error' : 'success',
        durationMs: Date.now() - watch.startedAt.getTime(),
        path: watch.path,
        watchId,
        errorMessage: isError ? reason : undefined
      });
    };

    watch.stopPromise = cleanup();
    return watch.stopPromise;
  }

  private runWatchLoop(
    watch: ActiveWatch,
    logger: Logger,
    startTime: number
  ): void {
    const stdout = watch.process.stdout;
    const stderr = watch.process.stderr;

    if (!stdout || typeof stdout === 'number') {
      const error = new Error('Failed to capture process output');
      this.rejectWatchReady(watch, error);
      void this.stopWatchInternal(watch.id, errorEvent(error.message));
      return;
    }

    void (async () => {
      try {
        if (stderr && typeof stderr !== 'number') {
          const monitor = await this.waitForWatchesEstablished(stderr);
          this.continueStderrMonitoring(
            monitor.reader,
            monitor.decoder,
            monitor.buffer,
            watch
          );
        }

        this.resolveWatchReady(watch);

        logCanonicalEvent(this.logger, {
          event: 'watch.start',
          outcome: 'success',
          durationMs: Date.now() - startTime,
          path: watch.path,
          watchId: watch.id,
          recursive: watch.recursive
        });

        const reader = stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            this.handleWatchLine(watch, line);
          }
        }

        if (buffer.trim()) {
          this.handleWatchLine(watch, buffer);
        }

        await this.stopWatchInternal(watch.id, {
          type: 'stopped',
          reason: 'Watch process ended'
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('Error reading watch output', err, {
          watchId: watch.id,
          path: watch.path
        });
        this.rejectWatchReady(watch, err);
        await this.stopWatchInternal(watch.id, errorEvent(err.message));
      }
    })();
  }

  private handleWatchLine(watch: ActiveWatch, line: string): void {
    if (!line.trim()) {
      return;
    }

    const parsed = this.parseInotifyEvent(line);
    if (!parsed) {
      return;
    }

    const timestamp = new Date().toISOString();
    watch.cursor += 1;
    watch.lastEventAt = timestamp;

    this.broadcastEvent(watch, {
      type: 'event',
      eventType: parsed.eventType,
      path: parsed.path,
      isDirectory: parsed.isDirectory,
      timestamp
    });
  }

  private resolveWatchReady(watch: ActiveWatch): void {
    if (watch.readyState !== 'pending') {
      return;
    }

    watch.readyState = 'resolved';
    watch.ready.resolve();
  }

  private rejectWatchReady(watch: ActiveWatch, error: Error): void {
    if (watch.readyState !== 'pending') {
      return;
    }

    watch.readyState = 'rejected';
    watch.ready.reject(error);
  }

  private buildInotifyArgs(path: string, options: WatchRequest): string[] {
    const args: string[] = ['-m', '--format', '%e|%w%f'];

    if (options.recursive !== false) {
      args.push('-r');
    }

    const events = this.normalizeEvents(options.events);
    const inotifyEvents = events
      .map((eventType) => this.mapEventType(eventType))
      .filter((eventType): eventType is string => eventType !== undefined);
    if (inotifyEvents.length > 0) {
      args.push('-e', inotifyEvents.join(','));
    }

    const includeRegex = this.buildCombinedPathRegex(
      this.normalizePatterns(options.include)
    );
    if (includeRegex) {
      args.push('--include', includeRegex);
    } else {
      const excludes =
        this.normalizePatterns(options.exclude) ?? DEFAULT_EXCLUDE_PATTERNS;
      const excludeRegex = this.buildCombinedPathRegex(excludes);
      if (excludeRegex) {
        args.push('--exclude', excludeRegex);
      }
    }

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

  private normalizePatterns(patterns?: string[]): string[] | undefined {
    if (!patterns || patterns.length === 0) {
      return undefined;
    }

    return Array.from(new Set(patterns)).sort();
  }

  private normalizeEvents(events?: FileWatchEventType[]): FileWatchEventType[] {
    if (!events || events.length === 0) {
      return DEFAULT_WATCH_EVENTS;
    }

    const orderedEvents = DEFAULT_WATCH_EVENTS.filter((eventType) =>
      events.includes(eventType)
    );
    const additionalEvents = events.filter(
      (eventType) => !orderedEvents.includes(eventType)
    );

    return [...orderedEvents, ...additionalEvents];
  }

  private buildCombinedPathRegex(patterns?: string[]): string | undefined {
    if (!patterns || patterns.length === 0) {
      return undefined;
    }

    return patterns
      .map((pattern) => `(^|/)${this.globToPathRegex(pattern)}(/|$)`)
      .join('|');
  }

  private globToPathRegex(pattern: string): string {
    return pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::double_star::')
      .replace(/\*/g, '[^/]*')
      .replace(/::double_star::/g, '.*')
      .replace(/\?/g, '[^/]');
  }

  private parseInotifyEvent(line: string): {
    eventType: FileWatchEventType;
    path: string;
    isDirectory: boolean;
  } | null {
    const parts = line.trim().split('|');
    if (parts.length < 2) {
      return null;
    }

    const [rawEvent, filePath, flagsPart] = parts;
    const isDirectory =
      rawEvent.includes('ISDIR') || (flagsPart?.includes('ISDIR') ?? false);

    const eventType = this.parseEventType(rawEvent);
    if (!eventType) {
      return null;
    }

    return { eventType, path: filePath, isDirectory };
  }

  private parseEventType(rawEvent: string): FileWatchEventType | null {
    const events = rawEvent.split(',');
    const primary = events[0].toLowerCase();

    const mapping: Record<string, FileWatchEventType> = {
      create: 'create',
      modify: 'modify',
      delete: 'delete',
      moved_from: 'move_from',
      moved_to: 'move_to',
      attrib: 'attrib',
      close_write: 'modify'
    };

    return mapping[primary] || null;
  }

  private async waitForWatchesEstablished(
    stderr: ReadableStream<Uint8Array>
  ): Promise<{
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
    decoder: TextDecoder;
    buffer: string;
  }> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readLoop = async (): Promise<'established'> => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error('Watch setup ended before watcher became ready');
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          if (trimmed.includes('Watches established')) {
            return 'established';
          }
          if (trimmed.includes('Setting up watches')) {
            continue;
          }

          throw new Error(trimmed);
        }
      }
    };

    let setupTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        readLoop(),
        new Promise<'timeout'>((resolve) => {
          setupTimeout = setTimeout(
            () => resolve('timeout'),
            WATCH_SETUP_TIMEOUT_MS
          );
        })
      ]);

      if (result === 'timeout') {
        throw new Error('Timed out waiting for file watcher setup to complete');
      }

      return { reader, decoder, buffer };
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      if (setupTimeout) {
        clearTimeout(setupTimeout);
      }
    }
  }

  private continueStderrMonitoring(
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
    decoder: TextDecoder,
    initialBuffer: string,
    watch: ActiveWatch
  ): void {
    void (async () => {
      let buffer = initialBuffer;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            if (
              trimmed.includes('Watches established') ||
              trimmed.includes('Setting up watches')
            ) {
              continue;
            }

            await this.stopWatchInternal(watch.id, errorEvent(trimmed));
            return;
          }
        }
      } catch {
        // Stream closed or process terminated — expected during cleanup.
      }
    })();
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] = () => {};
  let reject: Deferred<T>['reject'] = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function errorEvent(message: string): TerminalWatchEvent {
  return {
    type: 'error',
    error: message
  };
}
