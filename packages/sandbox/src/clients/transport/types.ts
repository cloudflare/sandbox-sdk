import type { Logger } from '@repo/shared';
import type { ContainerStub } from '../types';

/**
 * Transport modes supported by the route-based compatibility layer.
 */
export type RouteTransportMode = 'http' | 'websocket';

/** Alias for the transport package API. */
export type TransportMode = RouteTransportMode;

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

  /** Total retry budget in milliseconds for retryable transport responses.
   *  Used for WebSocket upgrade retries and HTTP 503 startup retries. Defaults
   *  to 120_000 (2 minutes). Set this at least as large as
   *  instanceGetTimeoutMS + portReadyTimeoutMS so the client waits through the
   *  expected container startup window. */
  retryTimeoutMs?: number;
}

export interface TransportRequestInit extends RequestInit {
  /** Override the non-streaming request timeout for this single request. */
  requestTimeoutMs?: number;
}

/**
 * Route transport interface.
 *
 * Provides a unified abstraction over the route-based HTTP and custom
 * WebSocket compatibility paths. Both transports support fetch-compatible
 * requests and streaming.
 */
export interface ITransport {
  /**
   * Make a fetch-compatible request
   * @returns Standard Response object
   */
  fetch(path: string, options?: TransportRequestInit): Promise<Response>;

  /**
   * Make a streaming request
   * @returns ReadableStream for consuming SSE/streaming data
   */
  fetchStream(
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST',
    headers?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Get the transport mode
   */
  getMode(): RouteTransportMode;

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
   * Update the upgrade retry budget without recreating the transport
   */
  setRetryTimeoutMs(ms: number): void;
}
