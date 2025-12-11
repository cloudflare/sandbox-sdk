import type { Logger } from '@repo/shared';
import type { CircuitBreaker, CircuitBreakerOptions } from './circuit-breaker';
import type { RequestQueue, RequestQueueOptions } from './request-queue';

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
 * Resilience configuration for the HTTP client
 * Controls circuit breaker and request queue behavior
 */
export interface ResilienceOptions {
  /**
   * Circuit breaker configuration
   * Set to false to disable circuit breaker entirely
   */
  circuitBreaker?: CircuitBreakerOptions | false;

  /**
   * Request queue configuration
   * Set to false to disable request queuing entirely
   */
  requestQueue?: RequestQueueOptions | false;
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
   * Resilience configuration (circuit breaker, request queue)
   * These components are shared across all domain clients
   */
  resilience?: ResilienceOptions;

  /**
   * Shared circuit breaker instance (injected by SandboxClient)
   * @internal
   */
  _circuitBreaker?: CircuitBreaker;

  /**
   * Shared request queue instance (injected by SandboxClient)
   * @internal
   */
  _requestQueue?: RequestQueue;
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
