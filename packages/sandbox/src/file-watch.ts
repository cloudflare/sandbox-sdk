import {
  type createLogger,
  type FileWatchSSEEvent,
  parseSSEFrames,
  type SSEPartialEvent,
  type WatchEvent,
  type WatchEventType,
  type WatchHandle
} from '@repo/shared';

/** Watch lifecycle state */
type WatchState = 'establishing' | 'active' | 'stopped';

/**
 * Encapsulates the entire file watch lifecycle with a single-loop state machine.
 *
 * States:
 *   establishing -> active -> stopped
 *
 * The same read loop handles both establishment and event processing,
 * transitioning state when the 'watching' confirmation arrives.
 *
 * @internal This class is not part of the public API.
 */
export class FileWatch implements WatchHandle {
  readonly path: string;

  private readonly abortController = new AbortController();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly onEvent?: (event: WatchEvent) => void;
  private readonly onError?: (error: Error) => void;

  private state: WatchState = 'establishing';
  private watchId = '';
  private buffer = '';
  private loopPromise: Promise<void>;

  // Resolver for the establishment promise - called when state transitions
  private establishedResolve?: () => void;
  private establishedReject?: (error: Error) => void;

  private constructor(
    stream: ReadableStream<Uint8Array>,
    path: string,
    logger: ReturnType<typeof createLogger>,
    externalSignal?: AbortSignal,
    onEvent?: (event: WatchEvent) => void,
    onError?: (error: Error) => void
  ) {
    this.path = path;
    this.reader = stream.getReader();
    this.logger = logger;
    this.onEvent = onEvent;
    this.onError = onError;

    if (externalSignal) {
      if (externalSignal.aborted) {
        this.abortController.abort();
      } else {
        externalSignal.addEventListener(
          'abort',
          () => {
            void this.stop();
          },
          { once: true }
        );
      }
    }

    // Start the single event loop
    this.loopPromise = this.runLoop();
  }

  get id(): string {
    return this.watchId;
  }

  /**
   * Creates a FileWatch, waiting for the watch to be established before returning.
   *
   * @throws Error if watch cannot be established
   */
  static async create(
    stream: ReadableStream<Uint8Array>,
    path: string,
    logger: ReturnType<typeof createLogger>,
    options?: {
      signal?: AbortSignal;
      onEvent?: (event: WatchEvent) => void;
      onError?: (error: Error) => void;
    }
  ): Promise<FileWatch> {
    const watch = new FileWatch(
      stream,
      path,
      logger,
      options?.signal,
      options?.onEvent,
      options?.onError
    );

    // Wait for establishment or failure
    await watch.established();
    return watch;
  }

  /**
   * Returns a promise that resolves when watch is established, or rejects on failure.
   * Rejects if the abort signal fires before establishment completes.
   */
  private established(): Promise<void> {
    if (this.state === 'active') {
      return Promise.resolve();
    }
    if (this.state === 'stopped') {
      return Promise.reject(new Error('Watch failed to establish'));
    }
    if (this.abortController.signal.aborted) {
      return Promise.reject(
        new Error('Watch was aborted before establishment')
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.establishedResolve = resolve;
      this.establishedReject = reject;

      const signal = this.abortController.signal;
      if (signal.aborted) {
        reject(new Error('Watch was aborted before establishment'));
        return;
      }

      const onAbort = () => {
        reject(new Error('Watch was aborted during establishment'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const originalResolve = this.establishedResolve;
      const originalReject = this.establishedReject;
      this.establishedResolve = () => {
        signal.removeEventListener('abort', onAbort);
        originalResolve?.();
      };
      this.establishedReject = (err: Error) => {
        signal.removeEventListener('abort', onAbort);
        originalReject?.(err);
      };
    });
  }

  /**
   * Single event loop handling both establishment and event processing.
   */
  private async runLoop(): Promise<void> {
    const signal = this.abortController.signal;

    let currentEvent: SSEPartialEvent = { data: [] };

    try {
      while (!signal.aborted) {
        const { done, value } = await this.reader.read();
        if (done) {
          if (this.state === 'establishing') {
            throw new Error('Stream ended before watch was established');
          }
          break;
        }

        this.buffer += this.decoder.decode(value, { stream: true });
        const parsed = parseSSEFrames(this.buffer, currentEvent);
        this.buffer = parsed.remaining;
        currentEvent = parsed.currentEvent;

        for (const frame of parsed.events) {
          if (signal.aborted) break;
          this.handleEvent(frame.data);
        }
      }

      // Flush any complete trailing frame.
      const finalParsed = parseSSEFrames(`${this.buffer}\n\n`, currentEvent);
      for (const frame of finalParsed.events) {
        if (signal.aborted) break;
        this.handleEvent(frame.data);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.state === 'establishing') {
        this.state = 'stopped';
        this.establishedReject?.(err);
      }
      this.onError?.(err);
      throw err;
    } finally {
      this.state = 'stopped';
      await this.reader.cancel().catch((cancelError) => {
        this.logger.debug('Reader cancel during cleanup', {
          error:
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError)
        });
      });
    }
  }

  /**
   * Type guard for FileWatchSSEEvent.
   * Validates required fields for each event type to prevent undefined access.
   */
  private isFileWatchSSEEvent(value: unknown): value is FileWatchSSEEvent {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj.type !== 'string') return false;

    switch (obj.type) {
      case 'watching':
        return typeof obj.path === 'string' && typeof obj.watchId === 'string';
      case 'event':
        return (
          typeof obj.eventType === 'string' &&
          typeof obj.path === 'string' &&
          typeof obj.isDirectory === 'boolean'
        );
      case 'error':
        return typeof obj.error === 'string';
      case 'stopped':
        return typeof obj.reason === 'string';
      default:
        return false;
    }
  }

  /**
   * Handles a single SSE event based on current state.
   */
  private handleEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.logger.debug('Malformed JSON in watch SSE event', {
        data: data.substring(0, 200)
      });
      return;
    }

    if (!this.isFileWatchSSEEvent(parsed)) {
      this.logger.debug('Invalid watch SSE event structure', {
        type: (parsed as Record<string, unknown>)?.type
      });
      return;
    }

    const event = parsed;

    switch (event.type) {
      case 'watching':
        if (this.state === 'establishing') {
          this.watchId = event.watchId;
          this.state = 'active';
          this.establishedResolve?.();
        }
        break;

      case 'event':
        if (this.state === 'active') {
          this.onEvent?.({
            type: this.mapEventType(event.eventType),
            path: event.path,
            isDirectory: event.isDirectory
          });
        }
        break;

      case 'error': {
        const error = new Error(event.error);
        if (this.state === 'establishing') {
          this.state = 'stopped';
          this.abortController.abort();
          this.establishedReject?.(error);
        } else {
          this.logger.error('Watch error from server', error);
          this.onError?.(error);
        }
        break;
      }

      case 'stopped':
        this.abortController.abort();
        break;
    }
  }

  private mapEventType(
    sseType: 'create' | 'modify' | 'delete' | 'move_from' | 'move_to' | 'attrib'
  ): WatchEventType {
    switch (sseType) {
      case 'create':
        return 'create';
      case 'modify':
      case 'attrib':
        return 'modify';
      case 'delete':
        return 'delete';
      case 'move_from':
      case 'move_to':
        return 'rename';
    }
  }

  /**
   * Stops watching and releases all resources.
   * Safe to call multiple times. Waits for full cleanup.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      await this.loopPromise.catch(() => {});
      return;
    }

    this.abortController.abort();

    await this.loopPromise.catch(() => {});
  }
}
