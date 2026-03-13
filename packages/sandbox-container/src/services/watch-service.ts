import type {
  FileWatchEventType,
  FileWatchSSEEvent,
  Logger,
  WatchRequest,
  WatchState
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { Subprocess } from 'bun';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

interface WatchSubscriber {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  pendingEvents: Map<string, FileWatchSSEEvent>;
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
  leaseToken: string | null;
  resumeToken: string | null;
  state: WatchState;
  persistent: boolean;
  subscribers: Map<string, WatchSubscriber>;
  ready: Deferred<void>;
  readyState: 'pending' | 'resolved' | 'rejected';
  expiryTimer: ReturnType<typeof setTimeout> | null;
  stopPromise?: Promise<void>;
}

type TerminalWatchEvent = Extract<
  FileWatchSSEEvent,
  { type: 'error' | 'stopped' }
>;

const WATCH_SETUP_TIMEOUT_MS = 10000;
const EVENT_COALESCE_WINDOW_MS = 75;
const MAX_PENDING_EVENTS = 1000;
const PERSISTENT_WATCH_IDLE_TTL_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 5000;

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
      return watchResult;
    }

    const stream = this.createSubscriberStream(watchResult.data);
    return serviceSuccess(stream);
  }

  /**
   * Ensure a persistent watch exists and wait until it is ready.
   */
  async ensureWatch(
    path: string,
    options: WatchRequest = { path }
  ): Promise<ServiceResult<{ watch: WatchState; leaseToken: string }>> {
    const watchResult = this.getOrCreateWatch(path, options);
    if (!watchResult.success) {
      return watchResult;
    }

    const watch = watchResult.data;
    const leaseResult = this.claimPersistentWatch(watch, options.resumeToken);
    if (!leaseResult.success) {
      return serviceError(leaseResult.error);
    }

    watch.persistent = true;
    this.refreshPersistentWatchLease(watch);

    try {
      await watch.ready.promise;
      return serviceSuccess({
        watch: this.snapshotWatchState(watch),
        leaseToken: leaseResult.leaseToken
      });
    } catch (error) {
      return serviceError({
        message:
          error instanceof Error
            ? error.message
            : 'Failed to establish persistent watch',
        code: ErrorCode.WATCH_START_ERROR,
        details: { path }
      });
    }
  }

  /**
   * Return the current state for a persistent or active watch.
   */
  async getWatchState(watchId: string): Promise<ServiceResult<WatchState>> {
    const watch = this.activeWatches.get(watchId);
    if (!watch) {
      return serviceError({
        message: `Watch not found: ${watchId}`,
        code: ErrorCode.WATCH_NOT_FOUND,
        details: { watchId }
      });
    }

    try {
      await watch.ready.promise;
      this.refreshPersistentWatchLease(watch);
      return serviceSuccess(this.snapshotWatchState(watch));
    } catch (error) {
      return serviceError({
        message:
          error instanceof Error ? error.message : 'Watch failed to establish',
        code: ErrorCode.WATCH_START_ERROR,
        details: { watchId }
      });
    }
  }

  /**
   * Acknowledge the current watch cursor.
   */
  async checkpointWatch(
    watchId: string,
    cursor: number,
    leaseToken: string
  ): Promise<ServiceResult<{ checkpointed: boolean; watch: WatchState }>> {
    const watch = this.activeWatches.get(watchId);
    if (!watch) {
      return serviceError({
        message: `Watch not found: ${watchId}`,
        code: ErrorCode.WATCH_NOT_FOUND,
        details: { watchId }
      });
    }

    try {
      await watch.ready.promise;
    } catch (error) {
      return serviceError({
        message:
          error instanceof Error ? error.message : 'Watch failed to establish',
        code: ErrorCode.WATCH_START_ERROR,
        details: { watchId }
      });
    }

    const leaseError = this.verifyPersistentWatchLease(
      watch,
      leaseToken,
      'checkpoint'
    );
    if (leaseError) {
      return serviceError(leaseError);
    }

    const checkpointed = cursor === watch.state.cursor;
    if (checkpointed) {
      watch.state.changed = false;
      watch.state.overflowed = false;
    }

    this.refreshPersistentWatchLease(watch);

    return serviceSuccess({
      checkpointed,
      watch: this.snapshotWatchState(watch)
    });
  }

  /**
   * Stop a specific watch.
   */
  async stopWatch(
    watchId: string,
    leaseToken?: string
  ): Promise<ServiceResult<void>> {
    const watch = this.activeWatches.get(watchId);
    if (!watch) {
      return serviceError({
        message: `Watch not found: ${watchId}`,
        code: ErrorCode.WATCH_NOT_FOUND,
        details: { watchId }
      });
    }

    const leaseError = this.verifyPersistentWatchLease(
      watch,
      leaseToken,
      'stop'
    );
    if (leaseError) {
      return serviceError(leaseError);
    }

    await this.stopWatchInternal(watchId, {
      type: 'stopped',
      reason: 'Watch stopped'
    });

    return serviceSuccess(undefined);
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
  getActiveWatches(): WatchState[] {
    return Array.from(this.activeWatches.values()).map((watch) =>
      this.snapshotWatchState(watch)
    );
  }

  private getOrCreateWatch(
    path: string,
    options: WatchRequest
  ): ServiceResult<ActiveWatch> {
    const include = this.normalizePatterns(options.include);
    const exclude = include
      ? undefined
      : this.normalizePatterns(options.exclude);
    const events = this.normalizeEvents(options.events);
    const key = this.createWatchKey(path, {
      recursive: options.recursive !== false,
      include,
      exclude,
      events
    });
    const existingWatchId = this.watchIdsByKey.get(key);
    if (existingWatchId) {
      const existing = this.activeWatches.get(existingWatchId);
      if (existing) {
        return serviceSuccess(existing);
      }
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
    const watchLogger = this.logger.child({ watchId, path });
    watchLogger.debug('Starting inotifywait', { args });

    try {
      const proc = Bun.spawn(['inotifywait', ...args], {
        stdout: 'pipe',
        stderr: 'pipe'
      });

      const watch: ActiveWatch = {
        id: watchId,
        key,
        path,
        recursive: options.recursive !== false,
        include,
        exclude,
        process: proc,
        startedAt: new Date(),
        leaseToken: null,
        resumeToken: null,
        state: {
          watchId,
          path,
          recursive: options.recursive !== false,
          include,
          exclude,
          cursor: 0,
          changed: false,
          overflowed: false,
          lastEventAt: null,
          expiresAt: null,
          subscriberCount: 0,
          startedAt: new Date().toISOString()
        },
        persistent: false,
        subscribers: new Map(),
        ready: createDeferred<void>(),
        readyState: 'pending',
        expiryTimer: null
      };

      this.activeWatches.set(watchId, watch);
      this.watchIdsByKey.set(key, watchId);
      this.runWatchLoop(watch, watchLogger);

      return serviceSuccess(watch);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      watchLogger.error('Failed to start inotifywait', err);
      return serviceError({
        message: `Failed to start file watcher: ${err.message}`,
        code: ErrorCode.WATCH_START_ERROR,
        details: { path }
      });
    }
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
    const include = options.include
      ? Array.from(new Set(options.include)).sort()
      : null;
    const exclude = options.exclude
      ? Array.from(new Set(options.exclude)).sort()
      : null;
    return JSON.stringify({
      path,
      recursive: options.recursive,
      include,
      exclude,
      events: this.normalizeEvents(options.events)
    });
  }

  private snapshotWatchState(watch: ActiveWatch): WatchState {
    return {
      ...watch.state,
      include: watch.include,
      exclude: watch.exclude,
      subscriberCount: watch.subscribers.size,
      startedAt: watch.startedAt.toISOString()
    };
  }

  private claimPersistentWatch(
    watch: ActiveWatch,
    resumeToken?: string
  ):
    | { success: true; leaseToken: string }
    | {
        success: false;
        error: {
          message: string;
          code: string;
          details?: Record<string, unknown>;
        };
      } {
    if (!watch.leaseToken) {
      const nextLeaseToken = crypto.randomUUID();
      watch.leaseToken = nextLeaseToken;
      watch.resumeToken = resumeToken ?? null;
      return { success: true, leaseToken: nextLeaseToken };
    }

    if (
      !watch.resumeToken ||
      !resumeToken ||
      watch.resumeToken !== resumeToken
    ) {
      return {
        success: false,
        error: {
          message:
            'A persistent watch already exists for this path. Reuse it with the same resumeToken or wait for it to expire.',
          code: ErrorCode.RESOURCE_BUSY,
          details: {
            watchId: watch.id
          }
        }
      };
    }

    return { success: true, leaseToken: watch.leaseToken };
  }

  private verifyPersistentWatchLease(
    watch: ActiveWatch,
    leaseToken: string | undefined,
    action: 'checkpoint' | 'stop'
  ): {
    message: string;
    code: string;
    details?: Record<string, unknown>;
  } | null {
    if (!watch.persistent || !watch.leaseToken) {
      return {
        message: `Only persistent watches can ${action}.`,
        code: ErrorCode.RESOURCE_BUSY,
        details: {
          watchId: watch.id,
          action
        }
      };
    }

    if (!leaseToken) {
      return {
        message: `Persistent watch requires a lease token to ${action}.`,
        code: ErrorCode.RESOURCE_BUSY,
        details: {
          watchId: watch.id,
          action
        }
      };
    }

    if (watch.leaseToken !== leaseToken) {
      return {
        message: `Persistent watch lease token does not allow this ${action}.`,
        code: ErrorCode.RESOURCE_BUSY,
        details: {
          watchId: watch.id,
          action
        }
      };
    }

    return null;
  }

  private refreshPersistentWatchLease(watch: ActiveWatch): void {
    if (!watch.persistent) {
      watch.state.expiresAt = null;
      this.clearPersistentWatchExpiry(watch);
      return;
    }

    this.clearPersistentWatchExpiry(watch);

    if (watch.subscribers.size > 0) {
      watch.state.expiresAt = null;
      return;
    }

    const expiresAt = new Date(Date.now() + PERSISTENT_WATCH_IDLE_TTL_MS);
    watch.state.expiresAt = expiresAt.toISOString();
    watch.expiryTimer = setTimeout(() => {
      void this.stopWatchInternal(watch.id, {
        type: 'stopped',
        reason: 'Persistent watch expired after idle period'
      });
    }, PERSISTENT_WATCH_IDLE_TTL_MS);
  }

  private clearPersistentWatchExpiry(watch: ActiveWatch): void {
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
    watch.state.subscriberCount = watch.subscribers.size;
    this.refreshPersistentWatchLease(watch);
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
    if (!watch.persistent && watch.subscribers.size === 0) {
      await this.stopWatchInternal(watch.id, {
        type: 'stopped',
        reason: 'Watch stopped after last subscriber disconnected'
      });
      return;
    }

    this.refreshPersistentWatchLease(watch);
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
    watch.state.subscriberCount = watch.subscribers.size;

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
    event: FileWatchSSEEvent
  ): void {
    if (subscriber.closed) {
      return;
    }

    const key =
      event.type === 'event'
        ? `${event.eventType}|${event.path}|${event.isDirectory}`
        : `${event.type}|${Date.now()}`;

    if (
      !subscriber.pendingEvents.has(key) &&
      subscriber.pendingEvents.size >= MAX_PENDING_EVENTS
    ) {
      subscriber.droppedEvents++;
      watch.state.overflowed = true;

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
      watch.state.subscriberCount = watch.subscribers.size;
      void this.maybeStopWatchWhenUnused(watch);
    }
  }

  private broadcastEvent(watch: ActiveWatch, event: FileWatchSSEEvent): void {
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

      if (watch.readyState === 'pending') {
        const terminalMessage =
          resolvedTerminalEvent.type === 'error'
            ? resolvedTerminalEvent.error
            : resolvedTerminalEvent.reason;
        this.rejectWatchReady(watch, new Error(terminalMessage));
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

      this.clearPersistentWatchExpiry(watch);

      this.activeWatches.delete(watchId);
      this.watchIdsByKey.delete(watch.key);
    };

    watch.stopPromise = cleanup();
    return watch.stopPromise;
  }

  private runWatchLoop(watch: ActiveWatch, logger: Logger): void {
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
          const monitor = await this.waitForWatchesEstablished(stderr, logger);
          this.continueStderrMonitoring(
            monitor.reader,
            monitor.decoder,
            monitor.buffer,
            watch,
            logger
          );
        }

        this.resolveWatchReady(watch);

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
            if (!line.trim()) {
              continue;
            }

            const parsed = this.parseInotifyEvent(line);
            if (!parsed) {
              continue;
            }

            const timestamp = new Date().toISOString();
            const nextCursor = watch.state.cursor + 1;
            const event: Extract<FileWatchSSEEvent, { type: 'event' }> = {
              type: 'event',
              eventId: `${watch.id}:${nextCursor}`,
              eventType: parsed.eventType,
              path: parsed.path,
              isDirectory: parsed.isDirectory,
              timestamp
            };

            watch.state.cursor = nextCursor;
            watch.state.changed = true;
            watch.state.lastEventAt = timestamp;
            this.broadcastEvent(watch, event);
          }
        }

        if (buffer.trim()) {
          const parsed = this.parseInotifyEvent(buffer);
          if (parsed) {
            const timestamp = new Date().toISOString();
            const nextCursor = watch.state.cursor + 1;
            const event: Extract<FileWatchSSEEvent, { type: 'event' }> = {
              type: 'event',
              eventId: `${watch.id}:${nextCursor}`,
              eventType: parsed.eventType,
              path: parsed.path,
              isDirectory: parsed.isDirectory,
              timestamp
            };

            watch.state.cursor = nextCursor;
            watch.state.changed = true;
            watch.state.lastEventAt = timestamp;
            this.broadcastEvent(watch, event);
          }
        }

        await this.stopWatchInternal(watch.id, {
          type: 'stopped',
          reason: 'Watch process ended'
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('Error reading watch output', err);
        this.rejectWatchReady(watch, err);
        await this.stopWatchInternal(watch.id, errorEvent(err.message));
      }
    })();
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
      .map((e) => this.mapEventType(e))
      .filter((e): e is string => e !== undefined);
    if (inotifyEvents.length > 0) {
      args.push('-e', inotifyEvents.join(','));
    }

    const includeRegex = this.buildCombinedPathRegex(
      this.normalizePatterns(options.include)
    );
    if (includeRegex) {
      args.push('--include', includeRegex);
    } else {
      const excludes = this.normalizePatterns(options.exclude) ?? [
        '.git',
        'node_modules',
        '.DS_Store'
      ];
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
    const defaultEvents: FileWatchEventType[] = [
      'create',
      'modify',
      'delete',
      'move_from',
      'move_to'
    ];

    if (!events || events.length === 0) {
      return defaultEvents;
    }

    const orderedEvents = defaultEvents.filter((eventType) =>
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
    stderr: ReadableStream<Uint8Array>,
    logger: Logger
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
            logger.debug('inotifywait watches established');
            return 'established';
          }
          if (trimmed.includes('Setting up watches')) {
            logger.debug('inotifywait setting up watches', {
              message: trimmed
            });
            continue;
          }

          logger.warn('inotifywait stderr during setup', {
            message: trimmed
          });
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
        const timeoutMessage =
          'Timed out waiting for file watcher setup to complete';
        logger.warn(timeoutMessage, { timeoutMs: WATCH_SETUP_TIMEOUT_MS });
        throw new Error(timeoutMessage);
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
    watch: ActiveWatch,
    logger: Logger
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
              logger.debug('inotifywait info', { message: trimmed });
              continue;
            }

            logger.warn('inotifywait stderr', { message: trimmed });
            this.broadcastEvent(watch, errorEvent(trimmed));
          }
        }
      } catch (error) {
        logger.debug('stderr monitoring ended', {
          error: error instanceof Error ? error.message : 'Unknown'
        });
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
