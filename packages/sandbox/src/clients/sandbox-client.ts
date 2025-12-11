import { CircuitBreaker } from './circuit-breaker';
import { CommandClient } from './command-client';
import { FileClient } from './file-client';
import { GitClient } from './git-client';
import { InterpreterClient } from './interpreter-client';
import { PortClient } from './port-client';
import { ProcessClient } from './process-client';
import { RequestQueue } from './request-queue';
import type { HttpClientOptions } from './types';
import { UtilityClient } from './utility-client';

/**
 * Main sandbox client that composes all domain-specific clients
 * Provides organized access to all sandbox functionality
 *
 * Resilience features (circuit breaker, request queue) are shared across
 * all domain clients to provide coordinated protection against overload.
 */
export class SandboxClient {
  public readonly commands: CommandClient;
  public readonly files: FileClient;
  public readonly processes: ProcessClient;
  public readonly ports: PortClient;
  public readonly git: GitClient;
  public readonly interpreter: InterpreterClient;
  public readonly utils: UtilityClient;

  /** Shared circuit breaker instance */
  public readonly circuitBreaker?: CircuitBreaker;

  /** Shared request queue instance */
  public readonly requestQueue?: RequestQueue;

  constructor(options: HttpClientOptions) {
    // Create shared resilience instances based on configuration
    const resilience = options.resilience;

    // Create circuit breaker unless explicitly disabled
    if (resilience?.circuitBreaker !== false) {
      this.circuitBreaker = new CircuitBreaker(
        typeof resilience?.circuitBreaker === 'object'
          ? resilience.circuitBreaker
          : undefined
      );
    }

    // Create request queue unless explicitly disabled
    if (resilience?.requestQueue !== false) {
      this.requestQueue = new RequestQueue(
        typeof resilience?.requestQueue === 'object'
          ? resilience.requestQueue
          : undefined
      );
    }

    // Build client options with shared instances
    const clientOptions: HttpClientOptions = {
      baseUrl: 'http://localhost:3000',
      ...options,
      _circuitBreaker: this.circuitBreaker,
      _requestQueue: this.requestQueue
    };

    // Initialize all domain clients with shared options
    this.commands = new CommandClient(clientOptions);
    this.files = new FileClient(clientOptions);
    this.processes = new ProcessClient(clientOptions);
    this.ports = new PortClient(clientOptions);
    this.git = new GitClient(clientOptions);
    this.interpreter = new InterpreterClient(clientOptions);
    this.utils = new UtilityClient(clientOptions);
  }

  /**
   * Get current resilience statistics
   */
  getResilienceStats(): {
    circuitBreaker?: ReturnType<CircuitBreaker['getStats']>;
    requestQueue?: ReturnType<RequestQueue['getStats']>;
  } {
    return {
      circuitBreaker: this.circuitBreaker?.getStats(),
      requestQueue: this.requestQueue?.getStats()
    };
  }

  /**
   * Reset circuit breaker to closed state
   * Useful for manual intervention after fixing issues
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker?.reset();
  }

  /**
   * Clear the request queue, rejecting all pending requests
   * @param reason - Error message for rejected requests
   */
  clearRequestQueue(reason?: string): void {
    this.requestQueue?.clear(reason);
  }
}
