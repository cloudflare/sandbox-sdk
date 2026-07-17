import type {
  ProcessExit,
  ProcessLogCursor,
  ProcessLogEvent,
  ProcessStatus,
  SandboxCommand,
  WaitForLogResult
} from '../process-types.js';

/**
 * Represents a disposable resource with a cleanup function.
 * Common pattern used by VS Code, xterm.js, RxJS, and others.
 */
export interface Disposable {
  dispose(): void;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ProcessLogsOptions {
  since?: ProcessLogCursor;
  replay?: boolean;
  follow?: boolean;
  signal?: AbortSignal;
}

export interface WaitForExitOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface WaitForLogOptions extends WaitForExitOptions {
  stream?: 'stdout' | 'stderr' | 'both';
}

export interface ProcessOutput<T> {
  stdout: T;
  stderr: T;
  exitCode: number;
  signal?: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface ProcessOutputOptions extends WaitForExitOptions {
  maxBytes?: number;
}

export interface ProcessTextOutputOptions extends ProcessOutputOptions {
  encoding: 'utf8';
}

export interface SandboxProcess {
  readonly id: string;
  readonly pid: number;
  readonly exitCode: Promise<number>;
  status(): Promise<ProcessStatus>;
  logs(options?: ProcessLogsOptions): Promise<ReadableStream<ProcessLogEvent>>;
  waitForLog(
    pattern: string | RegExp,
    options?: WaitForLogOptions
  ): Promise<WaitForLogResult>;
  waitForExit(options?: WaitForExitOptions): Promise<ProcessExit>;
  output(options: ProcessTextOutputOptions): Promise<ProcessOutput<string>>;
  output(options?: ProcessOutputOptions): Promise<ProcessOutput<Uint8Array>>;
  waitForPort(port: number, options?: WaitForPortOptions): Promise<void>;
  kill(signal?: number): Promise<void>;
}

/**
 * Options for waiting for a port to become ready
 */
export interface WaitForPortOptions {
  /**
   * Check mode
   * - 'http': Make an HTTP request and check for success status
   * - 'tcp': Just check if TCP connection succeeds (default)
   * @default 'tcp'
   */
  mode?: 'http' | 'tcp';

  /**
   * HTTP path to check (only used when mode is 'http')
   * @default '/'
   */
  path?: string;

  /**
   * Expected HTTP status code or range (only used when mode is 'http')
   * - Single number: exact match (e.g., 200)
   * - Object with min/max: range match (e.g., { min: 200, max: 399 })
   * @default { min: 200, max: 399 }
   */
  status?: number | { min: number; max: number };

  /**
   * Maximum time to wait in milliseconds
   * @default no timeout
   */
  timeout?: number;

  /**
   * Signal used to cancel waiting locally.
   */
  signal?: AbortSignal;

  /**
   * Interval between checks in milliseconds
   * @default 500
   */
  interval?: number;
}

/**
 * Request body for port readiness check endpoint
 */
export interface PortCheckRequest {
  port: number;
  mode: 'http' | 'tcp';
  path?: string;
  statusMin?: number;
  statusMax?: number;
}

/**
 * Response from port readiness check endpoint
 */
export interface PortCheckResponse {
  ready: boolean;
  /** HTTP status code received (only for http mode) */
  statusCode?: number;
  /** Error message if check failed */
  error?: string;
}

/**
 * Request body for streaming port watch endpoint
 */
export interface PortWatchRequest extends PortCheckRequest {
  /** Process ID to monitor - stream closes if process exits */
  processId?: string;
  /** Internal polling interval in ms (default: 500) */
  interval?: number;
}

/**
 * SSE event emitted by port watch stream
 */
export type PortWatchEvent =
  | { type: 'watching'; port: number }
  | { type: 'ready'; port: number; statusCode?: number }
  | { type: 'error'; port: number; error: string };

export interface PortWatchRPCOptions {
  mode?: 'http' | 'tcp';
  path?: string;
  status?: number | { min: number; max: number };
  interval?: number;
}

export interface PortWatchSubscriptionAPI {
  stream(): Promise<ReadableStream<PortWatchEvent>>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}

// Sandbox configuration options
export interface SandboxOptions {
  /**
   * Duration after which the sandbox instance will sleep if no requests are received
   * Can be:
   * - A string like "30s", "3m", "5m", "1h" (seconds, minutes, or hours)
   * - A number representing seconds (e.g., 180 for 3 minutes)
   * Default: "10m" (10 minutes)
   *
   * Note: Ignored when keepAlive is true
   */
  sleepAfter?: string | number;

  /**
   * Keep the container alive indefinitely by preventing automatic shutdown
   * When true, the container will never auto-timeout and must be explicitly destroyed
   * - Any scenario where activity can't be automatically detected
   *
   * Important: You MUST call sandbox.destroy() when done to avoid resource leaks
   *
   * Default: false
   */
  keepAlive?: boolean;

  /**
   * Normalize sandbox ID to lowercase for preview URL compatibility
   *
   * Required for preview URLs because hostnames are case-insensitive (RFC 3986), which
   * would route requests to a different Durable Object instance with IDs containing uppercase letters.
   *
   * **Important:** Different normalizeId values create different Durable Object instances:
   * - `getSandbox(ns, "MyProject")` → DO key: "MyProject"
   * - `getSandbox(ns, "MyProject", {normalizeId: true})` → DO key: "myproject"
   *
   * **Future change:** In a future version, this will default to `true` (automatically lowercase all IDs).
   * IDs with uppercase letters will trigger a warning. To prepare, use lowercase IDs or explicitly
   * pass `normalizeId: true`.
   *
   * @example
   * getSandbox(ns, "my-project")  // Works with preview URLs (lowercase)
   * getSandbox(ns, "MyProject", {normalizeId: true})  // Normalized to "myproject"
   *
   * @default false
   */
  normalizeId?: boolean;

  /**
   * Container startup timeout configuration
   *
   * Tune timeouts based on your container's characteristics. SDK defaults (30s instance, 90s ports)
   * work for most use cases. Adjust for heavy containers or fail-fast applications.
   *
   * Can also be configured via environment variables:
   * - SANDBOX_INSTANCE_TIMEOUT_MS
   * - SANDBOX_PORT_TIMEOUT_MS
   * - SANDBOX_POLL_INTERVAL_MS
   *
   * Precedence: options > env vars > SDK defaults
   *
   * @example
   * // Heavy containers (ML models, large apps)
   * getSandbox(ns, id, {
   *   containerTimeouts: { portReadyTimeoutMS: 180_000 }
   * })
   *
   * @example
   * // Fail-fast for latency-sensitive apps
   * getSandbox(ns, id, {
   *   containerTimeouts: {
   *     instanceGetTimeoutMS: 15_000,
   *     portReadyTimeoutMS: 30_000
   *   }
   * })
   */
  containerTimeouts?: {
    /**
     * Time to wait for container instance provisioning
     * @default 30000 (30s) - or SANDBOX_INSTANCE_TIMEOUT_MS env var
     */
    instanceGetTimeoutMS?: number;

    /**
     * Time to wait for application startup and ports to be ready
     * @default 90000 (90s) - or SANDBOX_PORT_TIMEOUT_MS env var
     */
    portReadyTimeoutMS?: number;

    /**
     * How often to poll for container readiness
     * @default 300 (300ms) - or SANDBOX_POLL_INTERVAL_MS env var
     */
    waitIntervalMS?: number;
  };
}
