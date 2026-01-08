import type { Logger } from '@repo/shared';
import type { ContainerStub } from '../types';

/**
 * Transport mode for SDK communication
 */
export type TransportMode = 'http' | 'websocket';

/**
 * Configuration options for creating a transport
 */
export interface TransportConfig {
  /** Base URL for HTTP requests */
  baseUrl?: string;

  /** WebSocket URL (required for WebSocket mode) */
  wsUrl?: string;

  /** Logger instance */
  logger?: Logger;

  /** Container stub for DO-internal requests */
  stub?: ContainerStub;

  /** Port number */
  port?: number;

  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;

  /** Connection timeout in milliseconds (WebSocket only) */
  connectTimeoutMs?: number;
}

/**
 * Core transport interface - all transports must implement this
 *
 * Provides a unified abstraction over HTTP and WebSocket communication.
 * Both transports support fetch-compatible requests and streaming.
 *
 * For real-time bidirectional communication (like PTY), use the generic
 * sendMessage() and onStreamEvent() methods which WebSocket implements.
 * HTTP transport throws clear errors for these operations.
 */
export interface ITransport {
  /**
   * Make a fetch-compatible request
   * @returns Standard Response object
   */
  fetch(path: string, options?: RequestInit): Promise<Response>;

  /**
   * Make a streaming request
   * @returns ReadableStream for consuming SSE/streaming data
   */
  fetchStream(
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST'
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Get the transport mode
   */
  getMode(): TransportMode;

  /**
   * Connect the transport (no-op for HTTP)
   */
  connect(): Promise<void>;

  /**
   * Disconnect the transport (no-op for HTTP)
   */
  disconnect(): void;

  /**
   * Check if connected (always true for HTTP)
   */
  isConnected(): boolean;

  /**
   * Send a message over the transport (WebSocket only)
   *
   * Used for real-time bidirectional communication like PTY input/resize.
   * HTTP transport throws an error - use fetch() for HTTP operations.
   *
   * @param message - Message object to send (will be JSON serialized)
   * @throws Error if transport doesn't support real-time messaging
   */
  sendMessage(message: object): void;

  /**
   * Register a listener for stream events (WebSocket only)
   *
   * Used for real-time bidirectional communication like PTY data/exit events.
   * HTTP transport throws an error - use fetchStream() for SSE streams.
   *
   * @param streamId - Stream identifier (e.g., PTY ID)
   * @param event - Event type to listen for (e.g., 'pty_data', 'pty_exit')
   * @param callback - Callback function to invoke when event is received
   * @returns Unsubscribe function
   * @throws Error if transport doesn't support real-time messaging
   */
  onStreamEvent(
    streamId: string,
    event: string,
    callback: (data: string) => void
  ): () => void;
}
