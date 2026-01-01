import { BaseTransport } from './base-transport';
import type { TransportConfig, TransportMode } from './types';

/**
 * HTTP transport implementation
 *
 * Uses standard fetch API for communication with the container.
 * HTTP is stateless, so connect/disconnect are no-ops.
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

  sendPtyInput(_ptyId: string, _data: string): void {
    throw new Error(
      'sendPtyInput() not supported with HTTP transport. ' +
        'Use pty.write() which routes to POST /api/pty/:id/input'
    );
  }

  sendPtyResize(_ptyId: string, _cols: number, _rows: number): void {
    throw new Error(
      'sendPtyResize() not supported with HTTP transport. ' +
        'Use pty.resize() which routes to POST /api/pty/:id/resize'
    );
  }

  onPtyData(_ptyId: string, _callback: (data: string) => void): () => void {
    // HTTP transport doesn't support real-time PTY data events.
    // Data must be retrieved via SSE stream (GET /api/pty/:id/stream).
    this.logger.warn(
      'onPtyData() has no effect with HTTP transport. Use WebSocket transport for real-time events.'
    );
    return () => {};
  }

  onPtyExit(_ptyId: string, _callback: (exitCode: number) => void): () => void {
    // HTTP transport doesn't support real-time PTY exit events.
    // Exit must be detected via SSE stream (GET /api/pty/:id/stream).
    this.logger.warn(
      'onPtyExit() has no effect with HTTP transport. Use WebSocket transport for real-time events.'
    );
    return () => {};
  }
}
