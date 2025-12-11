/**
 * Configuration options for the request queue
 */
export interface RequestQueueOptions {
  /**
   * Maximum number of concurrent requests allowed
   * @default 10
   */
  maxConcurrent?: number;

  /**
   * Maximum number of requests waiting in queue
   * When exceeded, oldest requests are rejected
   * @default 100
   */
  maxQueueSize?: number;

  /**
   * Timeout for requests waiting in queue (milliseconds)
   * @default 30000 (30 seconds)
   */
  queueTimeout?: number;

  /**
   * Callback when a request is queued
   */
  onQueued?: (queueLength: number) => void;

  /**
   * Callback when a request is dequeued
   */
  onDequeued?: (waitTime: number) => void;
}

/**
 * Error thrown when queue is full and request is rejected
 */
export class QueueFullError extends Error {
  readonly name = 'QueueFullError';
  readonly queueSize: number;

  constructor(queueSize: number) {
    super(
      `Request queue is full (${queueSize} pending requests). Service is overloaded.`
    );
    this.queueSize = queueSize;
  }
}

/**
 * Error thrown when request times out waiting in queue
 */
export class QueueTimeoutError extends Error {
  readonly name = 'QueueTimeoutError';
  readonly waitTime: number;

  constructor(waitTime: number) {
    super(
      `Request timed out after ${Math.ceil(waitTime / 1000)}s waiting in queue.`
    );
    this.waitTime = waitTime;
  }
}

/**
 * Queued request with its resolver
 */
interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  queuedAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * Request queue with concurrency limiting
 *
 * Provides backpressure by limiting the number of concurrent requests
 * and queuing excess requests. This smooths out traffic bursts and
 * prevents overwhelming downstream services.
 *
 * Features:
 * - Configurable concurrency limit
 * - Queue size limit to prevent memory exhaustion
 * - Timeout for queued requests
 * - FIFO ordering for fairness
 */
export class RequestQueue {
  private readonly options: Required<
    Omit<RequestQueueOptions, 'onQueued' | 'onDequeued'>
  > & {
    onQueued?: RequestQueueOptions['onQueued'];
    onDequeued?: RequestQueueOptions['onDequeued'];
  };
  private activeCount = 0;
  private readonly queue: QueuedRequest<unknown>[] = [];

  constructor(options: RequestQueueOptions = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 10,
      maxQueueSize: options.maxQueueSize ?? 100,
      queueTimeout: options.queueTimeout ?? 30_000,
      onQueued: options.onQueued,
      onDequeued: options.onDequeued
    };
  }

  /**
   * Execute a request through the queue
   * Returns immediately if under concurrency limit, otherwise queues
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Fast path: under concurrency limit
    if (this.activeCount < this.options.maxConcurrent) {
      return this.executeNow(fn);
    }

    // Need to queue
    return this.enqueue(fn);
  }

  /**
   * Execute immediately, tracking active count
   */
  private async executeNow<T>(fn: () => Promise<T>): Promise<T> {
    this.activeCount++;

    try {
      return await fn();
    } finally {
      this.activeCount--;
      this.processQueue();
    }
  }

  /**
   * Add request to queue
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Check queue size limit
    if (this.queue.length >= this.options.maxQueueSize) {
      throw new QueueFullError(this.queue.length);
    }

    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();

      const request: QueuedRequest<T> = {
        execute: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAt
      };

      // Set up timeout
      request.timeoutId = setTimeout(() => {
        // Remove from queue
        const index = this.queue.indexOf(request as QueuedRequest<unknown>);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(new QueueTimeoutError(Date.now() - queuedAt));
        }
      }, this.options.queueTimeout);

      this.queue.push(request as QueuedRequest<unknown>);
      this.options.onQueued?.(this.queue.length);
    });
  }

  /**
   * Process next request from queue if capacity available
   */
  private processQueue(): void {
    if (this.queue.length === 0) {
      return;
    }

    if (this.activeCount >= this.options.maxConcurrent) {
      return;
    }

    const request = this.queue.shift();
    if (!request) {
      return;
    }

    // Clear timeout
    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }

    const waitTime = Date.now() - request.queuedAt;
    this.options.onDequeued?.(waitTime);

    // Execute the request
    this.executeNow(request.execute)
      .then(request.resolve)
      .catch(request.reject);
  }

  /**
   * Get current queue statistics
   */
  getStats(): {
    activeCount: number;
    queueLength: number;
    maxConcurrent: number;
    maxQueueSize: number;
  } {
    return {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      maxConcurrent: this.options.maxConcurrent,
      maxQueueSize: this.options.maxQueueSize
    };
  }

  /**
   * Check if queue has capacity for new requests
   */
  hasCapacity(): boolean {
    return (
      this.activeCount < this.options.maxConcurrent ||
      this.queue.length < this.options.maxQueueSize
    );
  }

  /**
   * Clear the queue, rejecting all pending requests
   * @param reason - Error message for rejected requests
   */
  clear(reason = 'Queue cleared'): void {
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (request) {
        if (request.timeoutId) {
          clearTimeout(request.timeoutId);
        }
        request.reject(new Error(reason));
      }
    }
  }
}
