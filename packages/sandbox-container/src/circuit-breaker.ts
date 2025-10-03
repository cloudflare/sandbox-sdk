/**
 * Circuit Breaker implementation to prevent cascading failures
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailure: number = 0;
  private successCount = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  // Configuration
  private readonly threshold: number;
  private readonly timeout: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly name: string;

  constructor(options: {
    name: string;
    threshold?: number;
    timeout?: number;
    halfOpenSuccessThreshold?: number;
  }) {
    this.name = options.name;
    this.threshold = options.threshold || 5;
    this.timeout = options.timeout || 30000; // 30 seconds
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold || 3;
  }

  /**
   * Execute an operation with circuit breaker protection
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check circuit state
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.timeout) {
        console.log(
          `[CircuitBreaker ${this.name}] Transitioning from open to half-open`
        );
        this.state = "half-open";
        this.successCount = 0;
      } else {
        throw new Error(
          `Circuit breaker is open for ${this.name}. Retry after ${
            this.timeout - (Date.now() - this.lastFailure)
          }ms`
        );
      }
    }

    try {
      const result = await operation();

      // Record success
      if (this.state === "half-open") {
        this.successCount++;
        if (this.successCount >= this.halfOpenSuccessThreshold) {
          console.log(
            `[CircuitBreaker ${this.name}] Transitioning from half-open to closed`
          );
          this.state = "closed";
          this.failures = 0;
        }
      } else if (this.state === "closed") {
        // Reset failure count on success
        this.failures = 0;
      }

      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Record a failure and update circuit state
   */
  private recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.state === "half-open") {
      console.log(
        `[CircuitBreaker ${this.name}] Failure in half-open state, transitioning to open`
      );
      this.state = "open";
    } else if (this.failures >= this.threshold) {
      console.log(
        `[CircuitBreaker ${this.name}] Threshold reached (${this.failures}/${this.threshold}), transitioning to open`
      );
      this.state = "open";
    }
  }

  /**
   * Get current circuit breaker state
   */
  getState(): {
    state: string;
    failures: number;
    lastFailure: number;
    isOpen: boolean;
  } {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
      isOpen: this.state === "open",
    };
  }

  /**
   * Reset the circuit breaker
   */
  reset() {
    this.state = "closed";
    this.failures = 0;
    this.successCount = 0;
    this.lastFailure = 0;
    console.log(`[CircuitBreaker ${this.name}] Reset to closed state`);
  }
}
