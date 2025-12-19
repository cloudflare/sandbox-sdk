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
 * - write: Send input to the terminal
 * - resize: Change terminal dimensions
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

  /** Send input to PTY */
  write(data: string): void;

  /** Resize terminal */
  resize(cols: number, rows: number): void;

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

  write(data: string): void {
    if (this.closed) return;

    if (this.transport.getMode() === 'websocket') {
      // WebSocket: use fire-and-forget message
      this.transport.sendPtyInput(this.id, data);
    } else {
      // HTTP: use POST endpoint (fire-and-forget, no await)
      this.transport
        .fetch(`/api/pty/${this.id}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data })
        })
        .catch((error: unknown) => {
          this.logger.warn('PTY write failed', { ptyId: this.id, error });
        });
    }
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;

    if (this.transport.getMode() === 'websocket') {
      // WebSocket: use fire-and-forget message
      this.transport.sendPtyResize(this.id, cols, rows);
    } else {
      // HTTP: use POST endpoint (fire-and-forget, no await)
      this.transport
        .fetch(`/api/pty/${this.id}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols, rows })
        })
        .catch((error: unknown) => {
          this.logger.warn('PTY resize failed', { ptyId: this.id, error });
        });
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
    if (this.closed) return () => {};

    const unsub = this.transport.onPtyData(this.id, callback);
    this.dataListeners.push(unsub);
    return unsub;
  }

  onExit(callback: (exitCode: number) => void): () => void {
    if (this.closed) return () => {};

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

    const unsub = this.onData((data) => {
      queue.push(data);
      resolve?.();
    });

    this.onExit(() => {
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
      unsub();
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

    const result: PtyGetResult = await response.json();

    if (!result.success) {
      throw new Error('PTY not found');
    }

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

    const result: PtyListResult = await response.json();

    if (!result.success) {
      throw new Error('Failed to list PTYs');
    }

    this.logSuccess('PTYs listed', `${result.ptys.length} found`);

    return result.ptys;
  }
}
