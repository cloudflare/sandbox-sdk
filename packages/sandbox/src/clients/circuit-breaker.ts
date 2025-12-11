/**
 * Circuit breaker states
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Configuration options for the circuit breaker
 */
export interface CircuitBreakerOptions {
  /**
   * Number of failures in the window before opening the circuit
   * @default 5
   */
  failureThreshold?: number;

  /**
   * Time window in milliseconds for counting failures
   * @default 30000 (30 seconds)
   */
  failureWindow?: number;

  /**
   * Time in milliseconds to wait before attempting recovery (half-open state)
   * @default 10000 (10 seconds)
   */
  recoveryTimeout?: number;

  /**
   * Number of successful requests needed in half-open state to close the circuit
   * @default 2
   */
  successThreshold?: number;

  /**
   * Callback when circuit state changes
   */
  onStateChange?: (state: CircuitState, previousState: CircuitState) => void;
}

/**
 * Error thrown when circuit is open and requests are rejected
 */
export class CircuitOpenError extends Error {
  readonly name = 'CircuitOpenError';
  readonly remainingMs: number;

  constructor(remainingMs: number) {
    super(
      `Circuit breaker is open. Service is unavailable. Retry after ${Math.ceil(remainingMs / 1000)}s.`
    );
    this.remainingMs = remainingMs;
  }
}

/**
 * Circuit breaker implementation to protect against cascading failures
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 *
 * The circuit breaker tracks failures in a sliding window. When failures
 * exceed the threshold, it opens and rejects requests immediately. After
 * a recovery timeout, it enters half-open state to test if the service
 * has recovered.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number[] = []; // Timestamps of recent failures
  private successCount = 0; // Successes in half-open state
  private openedAt = 0; // When circuit opened
  private readonly options: Required<
    Omit<CircuitBreakerOptions, 'onStateChange'>
  > & {
    onStateChange?: CircuitBreakerOptions['onStateChange'];
  };

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      failureWindow: options.failureWindow ?? 30_000,
      recoveryTimeout: options.recoveryTimeout ?? 10_000,
      successThreshold: options.successThreshold ?? 2,
      onStateChange: options.onStateChange
    };
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if a request should be allowed through
   * @returns true if request can proceed, false if circuit is open
   * @throws CircuitOpenError if circuit is open (prefer using canExecute for non-throwing check)
   */
  canExecute(): boolean {
    this.cleanupOldFailures();

    switch (this.state) {
      case 'closed':
        return true;

      case 'open': {
        const elapsed = Date.now() - this.openedAt;
        if (elapsed >= this.options.recoveryTimeout) {
          // Transition to half-open
          this.setState('half-open');
          return true;
        }
        return false;
      }

      case 'half-open':
        // Allow limited requests through for testing
        return true;
    }
  }

  /**
   * Execute a request through the circuit breaker
   * Tracks success/failure and manages state transitions
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      const remaining =
        this.options.recoveryTimeout - (Date.now() - this.openedAt);
      throw new CircuitOpenError(remaining);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        // Service has recovered
        this.setState('closed');
        this.failures = [];
        this.successCount = 0;
      }
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    this.cleanupOldFailures();

    if (this.state === 'half-open') {
      // Any failure in half-open immediately reopens
      this.setState('open');
      this.openedAt = now;
      this.successCount = 0;
    } else if (this.state === 'closed') {
      if (this.failures.length >= this.options.failureThreshold) {
        this.setState('open');
        this.openedAt = now;
      }
    }
  }

  /**
   * Reset the circuit breaker to closed state
   * Useful for manual intervention or testing
   */
  reset(): void {
    this.setState('closed');
    this.failures = [];
    this.successCount = 0;
    this.openedAt = 0;
  }

  /**
   * Get statistics about the circuit breaker
   */
  getStats(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    remainingRecoveryMs: number | null;
  } {
    this.cleanupOldFailures();

    let remainingRecoveryMs: number | null = null;
    if (this.state === 'open') {
      remainingRecoveryMs = Math.max(
        0,
        this.options.recoveryTimeout - (Date.now() - this.openedAt)
      );
    }

    return {
      state: this.state,
      failureCount: this.failures.length,
      successCount: this.successCount,
      remainingRecoveryMs
    };
  }

  /**
   * Remove failures outside the sliding window
   */
  private cleanupOldFailures(): void {
    const cutoff = Date.now() - this.options.failureWindow;
    this.failures = this.failures.filter((timestamp) => timestamp > cutoff);
  }

  /**
   * Set state and notify listener
   */
  private setState(newState: CircuitState): void {
    if (this.state !== newState) {
      const previousState = this.state;
      this.state = newState;
      this.options.onStateChange?.(newState, previousState);
    }
  }
}
