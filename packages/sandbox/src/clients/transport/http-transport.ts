import { BaseTransport } from './base-transport';
import type { TransportConfig, TransportMode } from './types';

/**
 * HTTP transport implementation
 *
 * Uses standard fetch API for communication with the container.
 * HTTP is stateless, so connect/disconnect are no-ops.
 *
 * Real-time messaging (sendMessage, onStreamEvent) is NOT supported.
 * Features requiring real-time bidirectional communication (like PTY)
 * must use WebSocket transport.
 */
export class HttpTransport extends BaseTransport {
  private baseUrl: string;

  constructor(config: TransportConfig) {
    super(config);
    this.baseUrl = config.baseUrl ?? 'http://localhost:3000';
  }

  getMode(): TransportMode {
    return 'http';
  }

  async connect(): Promise<void> {
    // No-op for HTTP - stateless protocol
  }

  disconnect(): void {
    // No-op for HTTP - stateless protocol
  }

  isConnected(): boolean {
    return true; // HTTP is always "connected"
  }

  /**
   * HTTP does not support real-time messaging.
   * @throws Error explaining WebSocket is required
   */
  sendMessage(_message: object): void {
    throw new Error(
      'Real-time messaging requires WebSocket transport. ' +
        'PTY operations need continuous bidirectional communication. ' +
        'Use useWebSocket: true in sandbox options, or call sandbox.pty.create() ' +
        'which automatically uses WebSocket.'
    );
  }

  /**
   * HTTP does not support real-time event streaming.
   * @throws Error explaining WebSocket is required
   */
  onStreamEvent(
    _streamId: string,
    _event: string,
    _callback: (data: string) => void
  ): () => void {
    throw new Error(
      'Real-time event streaming requires WebSocket transport. ' +
        'PTY data/exit events need continuous bidirectional communication. ' +
        'Use useWebSocket: true in sandbox options, or call sandbox.pty.create() ' +
        'which automatically uses WebSocket.'
    );
  }

  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = this.buildUrl(path);

    if (this.config.stub) {
      return this.config.stub.containerFetch(
        url,
        options || {},
        this.config.port
      );
    }
    return globalThis.fetch(url, options);
  }

  async fetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.buildUrl(path);
    const options = this.buildStreamOptions(body, method);

    let response: Response;
    if (this.config.stub) {
      response = await this.config.stub.containerFetch(
        url,
        options,
        this.config.port
      );
    } else {
      response = await globalThis.fetch(url, options);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return response.body;
  }

  private buildUrl(path: string): string {
    if (this.config.stub) {
      return `http://localhost:${this.config.port}${path}`;
    }
    return `${this.baseUrl}${path}`;
  }

  private buildStreamOptions(
    body: unknown,
    method: 'GET' | 'POST'
  ): RequestInit {
    return {
      method,
      headers:
        body && method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : undefined,
      body: body && method === 'POST' ? JSON.stringify(body) : undefined
    };
  }
}
