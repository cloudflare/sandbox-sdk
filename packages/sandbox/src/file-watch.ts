import type {
  createLogger,
  FileWatchSSEEvent,
  WatchEvent,
  WatchEventType,
  WatchHandle
} from '@repo/shared';
import type { SandboxClient } from './clients';

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
  private readonly client: SandboxClient;
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
    client: SandboxClient,
    logger: ReturnType<typeof createLogger>,
    externalSignal?: AbortSignal,
    onEvent?: (event: WatchEvent) => void,
    onError?: (error: Error) => void
  ) {
    this.path = path;
    this.reader = stream.getReader();
    this.client = client;
    this.logger = logger;
    this.onEvent = onEvent;
    this.onError = onError;

    // Link external abort signal
    if (externalSignal) {
      if (externalSignal.aborted) {
        this.abortController.abort();
      } else {
        externalSignal.addEventListener(
          'abort',
          () => this.abortController.abort(),
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
    client: SandboxClient,
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
      client,
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
   */
  private established(): Promise<void> {
    // Already established
    if (this.state === 'active') {
      return Promise.resolve();
    }
    // Already failed
    if (this.state === 'stopped') {
      return Promise.reject(new Error('Watch failed to establish'));
    }
    // Wait for state transition
    return new Promise<void>((resolve, reject) => {
      this.establishedResolve = resolve;
      this.establishedReject = reject;
    });
  }

  /**
   * Single event loop handling both establishment and event processing.
   */
  private async runLoop(): Promise<void> {
    const signal = this.abortController.signal;

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
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (signal.aborted) break;
          if (line.startsWith('data: ')) {
            this.handleEvent(line);
          }
        }
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
      await this.reader.cancel().catch(() => {});
    }
  }

  /**
   * Type guard for FileWatchSSEEvent
   */
  private isFileWatchSSEEvent(value: unknown): value is FileWatchSSEEvent {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj.type !== 'string') return false;
    return ['watching', 'event', 'error', 'stopped'].includes(obj.type);
  }

  /**
   * Handles a single SSE event based on current state.
   */
  private handleEvent(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      return; // Ignore malformed JSON
    }

    if (!this.isFileWatchSSEEvent(parsed)) {
      return; // Ignore invalid event structure
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

    if (this.watchId) {
      try {
        await this.client.watch.stopWatch(this.watchId);
      } catch (error) {
        this.logger.warn('Failed to stop watch on server', {
          watchId: this.watchId,
          error
        });
      }
    }

    await this.loopPromise.catch(() => {});
  }
}
