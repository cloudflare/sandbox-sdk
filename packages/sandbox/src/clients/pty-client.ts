import type {
  AttachPtyOptions,
  CreatePtyOptions,
  Logger,
  PtyCreateResult,
  PtyGetResult,
  PtyInfo,
  PtyListResult
} from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { ITransport } from './transport/types';

/**
 * PTY handle returned by create/attach/get
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
  /** Associated session ID (if attached to session) */
  readonly sessionId?: string;
  /** Promise that resolves when PTY exits */
  readonly exited: Promise<{ exitCode: number }>;

  /**
   * Send input to PTY
   *
   * Returns a Promise that resolves on success or rejects on failure.
   * For interactive typing, you can ignore the promise (fire-and-forget).
   * For programmatic commands, await to catch errors.
   *
   * @note With HTTP transport, awaiting confirms delivery to the container.
   * With WebSocket transport, the promise resolves immediately after sending
   */
  write(data: string): Promise<void>;

  /**
   * Resize terminal
   *
   * Returns a Promise that resolves on success or rejects on failure.
   *
   * @note With HTTP transport, awaiting confirms the resize completed.
   * With WebSocket transport, the promise resolves immediately after sending.
   */
  resize(cols: number, rows: number): Promise<void>;

  /** Kill the PTY process */
  kill(signal?: string): Promise<void>;

  /** Register data listener */
  onData(callback: (data: string) => void): () => void;

  /** Register exit listener */
  onExit(callback: (exitCode: number) => void): () => void;

  /** Detach from PTY (PTY keeps running per disconnect timeout) */
  close(): void;
}

/**
 * Internal PTY handle implementation
 */
class PtyHandle implements Pty {
  readonly exited: Promise<{ exitCode: number }>;
  private closed = false;
  private dataListeners: Array<() => void> = [];
  private exitListeners: Array<() => void> = [];

  constructor(
    readonly id: string,
    readonly sessionId: string | undefined,
    private transport: ITransport,
    private logger: Logger
  ) {
    // Setup exit promise
    this.exited = new Promise((resolve) => {
      const unsub = this.transport.onPtyExit(this.id, (exitCode) => {
        unsub(); // Clean up immediately
        resolve({ exitCode });
      });
      this.exitListeners.push(unsub);
    });
  }

  async write(data: string): Promise<void> {
    if (this.closed) {
      throw new Error('PTY is closed');
    }

    if (this.transport.getMode() === 'websocket') {
      // WebSocket: capture synchronous throws from transport
      try {
        this.transport.sendPtyInput(this.id, data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          'PTY write failed',
          error instanceof Error ? error : undefined,
          {
            ptyId: this.id
          }
        );
        throw new Error(`PTY write failed: ${message}`);
      }
      return;
    }

    // HTTP: await the response to surface errors
    const response = await this.transport.fetch(`/api/pty/${this.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      this.logger.error('PTY write failed', undefined, {
        ptyId: this.id,
        status: response.status,
        error: text
      });
      throw new Error(`PTY write failed: HTTP ${response.status}: ${text}`);
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.closed) {
      throw new Error('PTY is closed');
    }

    if (this.transport.getMode() === 'websocket') {
      // WebSocket: capture synchronous throws from transport
      try {
        this.transport.sendPtyResize(this.id, cols, rows);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          'PTY resize failed',
          error instanceof Error ? error : undefined,
          {
            ptyId: this.id,
            cols,
            rows
          }
        );
        throw new Error(`PTY resize failed: ${message}`);
      }
      return;
    }

    // HTTP: await the response to surface errors
    const response = await this.transport.fetch(`/api/pty/${this.id}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      this.logger.error('PTY resize failed', undefined, {
        ptyId: this.id,
        cols,
        rows,
        status: response.status,
        error: text
      });
      throw new Error(`PTY resize failed: HTTP ${response.status}: ${text}`);
    }
  }

  async kill(signal?: string): Promise<void> {
    const body = signal ? JSON.stringify({ signal }) : undefined;
    await this.transport.fetch(`/api/pty/${this.id}`, {
      method: 'DELETE',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body
    });
  }

  onData(callback: (data: string) => void): () => void {
    if (this.closed) {
      this.logger.warn(
        'Registering onData listener on closed PTY handle - callback will never fire',
        {
          ptyId: this.id
        }
      );
      return () => {};
    }

    const unsub = this.transport.onPtyData(this.id, callback);
    this.dataListeners.push(unsub);
    return unsub;
  }

  onExit(callback: (exitCode: number) => void): () => void {
    if (this.closed) {
      this.logger.warn(
        'Registering onExit listener on closed PTY handle - callback will never fire',
        {
          ptyId: this.id
        }
      );
      return () => {};
    }

    const unsub = this.transport.onPtyExit(this.id, callback);
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
 */
export class PtyClient extends BaseHttpClient {
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
    const response = await this.post<PtyCreateResult>(
      '/api/pty',
      options ?? {}
    );

    if (!response.success) {
      throw new Error('Failed to create PTY');
    }

    this.logSuccess('PTY created', response.pty.id);

    return new PtyHandle(
      response.pty.id,
      response.pty.sessionId,
      this.transport,
      this.logger
    );
  }

  /**
   * Attach a PTY to an existing session
   *
   * Creates a PTY that shares the working directory and environment
   * of an existing session.
   *
   * @param sessionId - Session ID to attach to
   * @param options - PTY options (terminal size)
   * @returns PTY handle for interacting with the terminal
   *
   * @example
   * const pty = await client.attach('session_123', { cols: 100, rows: 30 });
   */
  async attach(sessionId: string, options?: AttachPtyOptions): Promise<Pty> {
    const response = await this.post<PtyCreateResult>(
      `/api/pty/attach/${sessionId}`,
      options ?? {}
    );

    if (!response.success) {
      throw new Error('Failed to attach PTY to session');
    }

    this.logSuccess('PTY attached to session', sessionId);

    return new PtyHandle(
      response.pty.id,
      response.pty.sessionId,
      this.transport,
      this.logger
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
    const response = await this.doFetch(`/api/pty/${id}`, {
      method: 'GET'
    });

    // Use handleResponse to properly parse ErrorResponse on failure
    const result = await this.handleResponse<PtyGetResult>(response);

    this.logSuccess('PTY retrieved', id);

    return new PtyHandle(
      result.pty.id,
      result.pty.sessionId,
      this.transport,
      this.logger
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

  /**
   * Resize a PTY (synchronous - waits for completion)
   *
   * @param id - PTY ID
   * @param cols - Number of columns
   * @param rows - Number of rows
   */
  async resize(id: string, cols: number, rows: number): Promise<void> {
    const response = await this.doFetch(`/api/pty/${id}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows })
    });

    // Use handleResponse to properly parse ErrorResponse on failure
    await this.handleResponse<{ success: boolean }>(response);

    this.logSuccess('PTY resized', `${id} -> ${cols}x${rows}`);
  }

  /**
   * Send input to a PTY (synchronous - waits for completion)
   *
   * @param id - PTY ID
   * @param data - Input data to send
   */
  async write(id: string, data: string): Promise<void> {
    const response = await this.doFetch(`/api/pty/${id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    });

    // Use handleResponse to properly parse ErrorResponse on failure
    await this.handleResponse<{ success: boolean }>(response);

    this.logSuccess('PTY input sent', id);
  }

  /**
   * Kill a PTY (synchronous - waits for completion)
   *
   * @param id - PTY ID
   * @param signal - Optional signal to send (e.g., 'SIGTERM', 'SIGKILL')
   */
  async kill(id: string, signal?: string): Promise<void> {
    const response = await this.doFetch(`/api/pty/${id}`, {
      method: 'DELETE',
      headers: signal ? { 'Content-Type': 'application/json' } : undefined,
      body: signal ? JSON.stringify({ signal }) : undefined
    });

    // Use handleResponse to properly parse ErrorResponse on failure
    await this.handleResponse<{ success: boolean }>(response);

    this.logSuccess('PTY killed', id);
  }
}
