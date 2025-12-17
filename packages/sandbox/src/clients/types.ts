import type { Logger } from '@repo/shared';
import type { ITransport, TransportMode } from './transport';

/**
 * Minimal interface for container fetch functionality
 */
export interface ContainerStub {
  containerFetch(
    url: string,
    options: RequestInit,
    port?: number
  ): Promise<Response>;
}

/**
 * Shared HTTP client configuration options
 */
export interface HttpClientOptions {
  logger?: Logger;
  baseUrl?: string;
  port?: number;
  stub?: ContainerStub;
  onCommandComplete?: (
    success: boolean,
    exitCode: number,
    stdout: string,
    stderr: string,
    command: string
  ) => void;
  onError?: (error: string, command?: string) => void;

  /**
   * Transport mode: 'http' (default) or 'websocket'
   * WebSocket mode multiplexes all requests over a single connection,
   * reducing sub-request count in Workers/Durable Objects.
   */
  transportMode?: TransportMode;

  /**
   * WebSocket URL for WebSocket transport mode.
   * Required when transportMode is 'websocket'.
   */
  wsUrl?: string;

  /**
   * Shared transport instance (for internal use).
   * When provided, clients will use this transport instead of creating their own.
   */
  transport?: ITransport;
}

/**
 * Base response interface for all API responses
 */
export interface BaseApiResponse {
  success: boolean;
  timestamp: string;
}

/**
 * Standard error response structure - matches BaseHandler.createErrorResponse()
 */
export interface ApiErrorResponse {
  success: false;
  error: string;
  code: string;
  details?: any;
  timestamp: string;
}

/**
 * Validation error response structure - matches ValidationMiddleware
 */
export interface ValidationErrorResponse {
  error: string;
  message: string;
  details?: any[];
  timestamp: string;
}

/**
 * Legacy error response interface - deprecated, use ApiErrorResponse
 */
export interface ErrorResponse {
  error: string;
  details?: string;
  code?: string;
}

/**
 * HTTP request configuration
 */
export interface RequestConfig extends RequestInit {
  endpoint: string;
  data?: Record<string, any>;
}

/**
 * Typed response handler
 */
export type ResponseHandler<T> = (response: Response) => Promise<T>;

/**
 * Common session-aware request interface
 */
export interface SessionRequest {
  sessionId?: string;
}
