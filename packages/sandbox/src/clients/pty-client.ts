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
    private logger: Logger
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
 * Client for PTY operations
 *
 * Provides methods to create and manage pseudo-terminal sessions in the sandbox.
 * PTY operations require WebSocket transport for real-time bidirectional communication.
 * The client automatically creates and manages a dedicated WebSocket connection.
 */
export class PtyClient extends BaseHttpClient {
  /** Dedicated WebSocket transport for PTY real-time communication */
  private ptyTransport: WebSocketTransport | null = null;

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
   * Disconnect the PTY WebSocket transport
   * Called when the sandbox is destroyed or PTY operations are no longer needed.
   */
  disconnectPtyTransport(): void {
    if (this.ptyTransport) {
      this.ptyTransport.disconnect();
      this.ptyTransport = null;
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

    // Pass the dedicated WebSocket transport to the PTY handle
    return new PtyHandle(response.pty.id, ptyTransport, this.logger);
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

    return new PtyHandle(result.pty.id, ptyTransport, this.logger);
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
