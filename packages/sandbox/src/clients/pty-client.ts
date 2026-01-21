import type {
  CreatePtyOptions,
  Logger,
  PtyCreateResult,
  PtyGetResult,
  PtyInfo,
  PtyListResult
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { ITransport } from './transport/types';
import { WebSocketTransport } from './transport/ws-transport';

/**
 * PTY handle returned by create/get
 *
 * Provides methods for interacting with a PTY session:
 * - write: Send input to the terminal (returns Promise for error handling)
 * - resize: Change terminal dimensions (returns Promise for error handling)
 * - kill: Terminate the PTY process
 * - onData: Listen for output data
 * - onExit: Listen for process exit
 * - close: Detach from PTY (PTY continues running)
 */
export interface Pty extends AsyncIterable<string> {
  /** Unique PTY identifier */
  readonly id: string;
  /** Promise that resolves when PTY exits */
  readonly exited: Promise<{ exitCode: number }>;

  /**
   * Send input to PTY
   *
   * Returns a Promise that resolves on success or rejects on failure.
   * For interactive typing, you can ignore the promise (fire-and-forget).
   * For programmatic commands, await to catch errors.
   */
  write(data: string): Promise<void>;

  /**
   * Resize terminal
   *
   * Returns a Promise that resolves on success or rejects on failure.
   */
  resize(cols: number, rows: number): Promise<void>;

  /** Kill the PTY process */
  kill(signal?: string): Promise<void>;

  /** Register data listener */
  onData(callback: (data: string) => void): () => void;

  /** Register exit listener */
  onExit(callback: (exitCode: number) => void): () => void;

  /** Detach from PTY (PTY keeps running) */
  close(): void;
}

/**
 * Internal PTY handle implementation
 *
 * Uses WebSocket transport for real-time PTY I/O via generic sendMessage()
 * and onStreamEvent() methods. PTY requires WebSocket for bidirectional
 * real-time communication.
 */
class PtyHandle implements Pty {
  readonly exited: Promise<{ exitCode: number }>;
  private closed = false;
  private dataListeners: Array<() => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(
    readonly id: string,
    private transport: ITransport,
    private logger: Logger,
    private onCloseCallback?: () => void
  ) {
    // Setup exit promise using generic stream event listener
    this.exited = new Promise((resolve) => {
      const unsub = this.transport.onStreamEvent(
        this.id,
        'pty_exit',
        (data: string) => {
          unsub();
          try {
            const { exitCode } = JSON.parse(data);
            resolve({ exitCode });
          } catch {
            // If parse fails, resolve with default exit code
            resolve({ exitCode: 1 });
          }
          // Notify client when PTY process exits (unless already closed)
          if (!this.closed) {
            this.closed = true;
            this.onCloseCallback?.();
          }
        }
      );
      this.exitListeners.push(unsub);
    });
  }

  async write(data: string): Promise<void> {
    if (this.closed) {
      throw new Error('PTY is closed');
    }

    try {
      // Use generic sendMessage with PTY input payload
      this.transport.sendMessage({ type: 'pty_input', ptyId: this.id, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'PTY write failed',
        error instanceof Error ? error : undefined,
        { ptyId: this.id }
      );
      throw new Error(`PTY write failed: ${message}`);
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.closed) {
      throw new Error('PTY is closed');
    }

    try {
      // Use generic sendMessage with PTY resize payload
      this.transport.sendMessage({
        type: 'pty_resize',
        ptyId: this.id,
        cols,
        rows
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'PTY resize failed',
        error instanceof Error ? error : undefined,
        { ptyId: this.id, cols, rows }
      );
      throw new Error(`PTY resize failed: ${message}`);
    }
  }

  async kill(signal?: string): Promise<void> {
    const body = signal ? JSON.stringify({ signal }) : undefined;
    const response = await this.transport.fetch(`/api/pty/${this.id}`, {
      method: 'DELETE',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      this.logger.error('PTY kill failed', undefined, {
        ptyId: this.id,
        signal,
        status: response.status,
        error: text
      });
      throw new Error(`PTY kill failed: HTTP ${response.status}: ${text}`);
    }
  }

  onData(callback: (data: string) => void): () => void {
    if (this.closed) {
      this.logger.warn(
        'Registering onData listener on closed PTY handle - callback will never fire',
        { ptyId: this.id }
      );
      return () => {};
    }

    // Use generic stream event listener
    const unsub = this.transport.onStreamEvent(this.id, 'pty_data', callback);
    this.dataListeners.push(unsub);
    return unsub;
  }

  onExit(callback: (exitCode: number) => void): () => void {
    if (this.closed) {
      this.logger.warn(
        'Registering onExit listener on closed PTY handle - callback will never fire',
        { ptyId: this.id }
      );
      return () => {};
    }

    // Use generic stream event listener, parse exitCode from JSON data
    const unsub = this.transport.onStreamEvent(
      this.id,
      'pty_exit',
      (data: string) => {
        try {
          const { exitCode } = JSON.parse(data);
          callback(exitCode);
        } catch {
          callback(1); // Default exit code on parse failure
        }
      }
    );
    this.exitListeners.push(unsub);
    return unsub;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Unsubscribe all listeners
    for (const unsub of this.dataListeners) {
      unsub();
    }
    for (const unsub of this.exitListeners) {
      unsub();
    }
    this.dataListeners = [];
    this.exitListeners = [];

    // Notify client that this PTY handle is closed
    this.onCloseCallback?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    const queue: string[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const unsubData = this.onData((data) => {
      queue.push(data);
      resolve?.();
    });

    const unsubExit = this.onExit(() => {
      done = true;
      resolve?.();
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (!done) {
          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;
        }
      }
    } finally {
      unsubData();
      unsubExit();
    }
  }
}

/**
 * Default keepalive interval for PTY connections (5 minutes)
 *
 * This should be less than the default sleepAfter (10 minutes) to ensure
 * the activity timer is refreshed before the container sleeps.
 */
const DEFAULT_PTY_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Client for PTY operations
 *
 * Provides methods to create and manage pseudo-terminal sessions in the sandbox.
 * PTY operations require WebSocket transport for real-time bidirectional communication.
 * The client automatically creates and manages a dedicated WebSocket connection.
 *
 * **Activity Timeout**: PTY WebSocket messages don't reset the container's activity
 * timeout (they bypass the DO's fetch path). To prevent the container from sleeping
 * during active PTY sessions, this client sends periodic keepalive pings via HTTP.
 */
export class PtyClient extends BaseHttpClient {
  /** Dedicated WebSocket transport for PTY real-time communication */
  private ptyTransport: WebSocketTransport | null = null;

  /** Keepalive interval ID for resetting container activity timeout */
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  /** Number of active PTY handles - keepalive runs when > 0 */
  private activePtyCount = 0;

  /**
   * Get or create the dedicated WebSocket transport for PTY operations
   *
   * PTY requires WebSocket for continuous bidirectional communication.
   * This method lazily creates a WebSocket connection on first use.
   */
  private async getPtyTransport(): Promise<WebSocketTransport> {
    if (this.ptyTransport?.isConnected()) {
      return this.ptyTransport;
    }

    // Build WebSocket URL from HTTP client options
    const wsUrl = this.options.wsUrl ?? this.buildWsUrl();

    this.ptyTransport = new WebSocketTransport({
      wsUrl,
      baseUrl: this.options.baseUrl,
      logger: this.options.logger ?? createNoOpLogger(),
      stub: this.options.stub,
      port: this.options.port
    });

    await this.ptyTransport.connect();
    this.logger.debug('PTY WebSocket transport connected', { wsUrl });

    return this.ptyTransport;
  }

  /**
   * Build WebSocket URL from HTTP base URL
   */
  private buildWsUrl(): string {
    const baseUrl = this.options.baseUrl ?? 'http://localhost:3000';
    // Convert http(s) to ws(s)
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    return `${wsUrl}/ws`;
  }

  /**
   * Disconnect the PTY WebSocket transport and stop keepalive
   * Called when the sandbox is destroyed or PTY operations are no longer needed.
   */
  disconnectPtyTransport(): void {
    this.stopKeepalive();
    this.activePtyCount = 0;

    if (this.ptyTransport) {
      this.ptyTransport.disconnect();
      this.ptyTransport = null;
    }
  }

  /**
   * Start the keepalive interval if not already running
   *
   * Sends periodic HTTP pings to reset the container's activity timeout.
   * This ensures the container stays alive during active PTY sessions,
   * since WebSocket messages don't trigger activity timeout renewal.
   */
  private startKeepalive(): void {
    if (this.keepaliveInterval) {
      return; // Already running
    }

    this.logger.debug('Starting PTY keepalive');

    // Send keepalive ping immediately, then at regular intervals
    this.sendKeepalivePing();

    this.keepaliveInterval = setInterval(() => {
      this.sendKeepalivePing();
    }, DEFAULT_PTY_KEEPALIVE_INTERVAL_MS);
  }

  /**
   * Stop the keepalive interval
   */
  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      this.logger.debug('Stopping PTY keepalive');
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Send a keepalive ping via HTTP
   *
   * This goes through the normal fetch path which resets the activity timeout.
   * Errors are logged but don't throw - keepalive is best-effort.
   */
  private sendKeepalivePing(): void {
    // Use doFetch which goes through the HTTP path (resets activity timeout)
    this.doFetch('/api/ping', { method: 'GET' })
      .then((response) => {
        if (!response.ok) {
          this.logger.warn('PTY keepalive ping failed', {
            status: response.status
          });
        } else {
          this.logger.debug('PTY keepalive ping sent');
        }
      })
      .catch((error) => {
        // Log but don't throw - keepalive is best-effort
        this.logger.warn('PTY keepalive ping error', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  /**
   * Track PTY creation and start keepalive if needed
   */
  private onPtyCreated(): void {
    this.activePtyCount++;
    if (this.activePtyCount === 1) {
      this.startKeepalive();
    }
  }

  /**
   * Track PTY closure and stop keepalive if no more active PTYs
   */
  private onPtyClosed(): void {
    this.activePtyCount = Math.max(0, this.activePtyCount - 1);
    if (this.activePtyCount === 0) {
      this.stopKeepalive();
    }
  }

  /**
   * Create a new PTY session
   *
   * @param options - PTY creation options (terminal size, command, cwd, etc.)
   * @returns PTY handle for interacting with the terminal
   *
   * @example
   * const pty = await client.create({ cols: 80, rows: 24 });
   * pty.onData((data) => console.log(data));
   * pty.write('ls -la\n');
   */
  async create(options?: CreatePtyOptions): Promise<Pty> {
    // Ensure WebSocket transport is connected for real-time PTY I/O
    const ptyTransport = await this.getPtyTransport();

    const response = await this.post<PtyCreateResult>(
      '/api/pty',
      options ?? {}
    );

    if (!response.success) {
      throw new Error('Failed to create PTY');
    }

    this.logSuccess('PTY created', response.pty.id);

    // Track PTY creation for keepalive management
    this.onPtyCreated();

    // Pass the dedicated WebSocket transport and close callback to the PTY handle
    return new PtyHandle(response.pty.id, ptyTransport, this.logger, () =>
      this.onPtyClosed()
    );
  }

  /**
   * Get an existing PTY by ID
   *
   * @param id - PTY ID
   * @returns PTY handle
   *
   * @example
   * const pty = await client.getById('pty_123');
   */
  async getById(id: string): Promise<Pty> {
    // Ensure WebSocket transport is connected for real-time PTY I/O
    const ptyTransport = await this.getPtyTransport();

    const response = await this.doFetch(`/api/pty/${id}`, {
      method: 'GET'
    });

    // Use handleResponse to properly parse ErrorResponse on failure
    const result = await this.handleResponse<PtyGetResult>(response);

    this.logSuccess('PTY retrieved', id);

    // Track PTY retrieval for keepalive management (each handle counts)
    this.onPtyCreated();

    return new PtyHandle(result.pty.id, ptyTransport, this.logger, () =>
      this.onPtyClosed()
    );
  }

  /**
   * List all active PTY sessions
   *
   * @returns Array of PTY info objects
   *
   * @example
   * const ptys = await client.list();
   * console.log(`Found ${ptys.length} PTY sessions`);
   */
  async list(): Promise<PtyInfo[]> {
    const response = await this.doFetch('/api/pty', {
      method: 'GET'
    });

    // Use handleResponse to properly parse ErrorResponse on failure
    const result = await this.handleResponse<PtyListResult>(response);

    this.logSuccess('PTYs listed', `${result.ptys.length} found`);

    return result.ptys;
  }

  /**
   * Get PTY information by ID (without creating a handle)
   *
   * Use this when you need raw PTY info for serialization or inspection.
   * For interactive PTY usage, prefer getById() which returns a handle.
   *
   * @param id - PTY ID
   * @returns PTY info object
   */
  async getInfo(id: string): Promise<PtyInfo> {
    const response = await this.doFetch(`/api/pty/${id}`, {
      method: 'GET'
    });

    const result: PtyGetResult = await response.json();

    if (!result.success) {
      throw new Error('PTY not found');
    }

    this.logSuccess('PTY info retrieved', id);

    return result.pty;
  }
}
