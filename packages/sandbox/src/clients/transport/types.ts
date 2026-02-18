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

  /** Request timeout in milliseconds (non-streaming requests) */
  requestTimeoutMs?: number;

  /**
   * Idle timeout for streaming requests in milliseconds (WebSocket only).
   * The timer resets on every chunk, so streams stay alive as long as data
   * is flowing. Only triggers when the stream is silent for this duration.
   * @default 300000 (5 minutes)
   */
  streamIdleTimeoutMs?: number;

  /** Connection timeout in milliseconds (WebSocket only) */
  connectTimeoutMs?: number;
}

/**
 * Transport interface - all transports must implement this
 *
 * Provides a unified abstraction over HTTP and WebSocket communication.
 * Both transports support fetch-compatible requests and streaming.
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
}
