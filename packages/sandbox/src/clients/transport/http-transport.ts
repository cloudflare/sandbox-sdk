import { BaseTransport } from './base-transport';
import type { TransportMode, TransportRequestInit } from './types';

/**
 * HTTP transport implementation
 *
 * Uses standard fetch API for communication with the container.
 * HTTP is stateless, so connect/disconnect are no-ops.
 *
 * All HTTP request logic lives in {@link BaseTransport.httpFetch} and
 * {@link BaseTransport.httpFetchStream}; this subclass simply wires
 * the abstract `doFetch` / `fetchStream` hooks to those shared helpers.
 */
export class HttpTransport extends BaseTransport {
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
    options?: TransportRequestInit
  ): Promise<Response> {
    return this.httpFetch(path, options);
  }

  async fetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST',
    headers?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>> {
    return this.httpFetchStream(path, body, method, headers);
  }
}
