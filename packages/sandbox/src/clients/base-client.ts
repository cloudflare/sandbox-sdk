import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { getHttpStatus } from '@repo/shared/errors';
import type { ErrorResponse as NewErrorResponse } from '../errors';
import { createErrorFromResponse, ErrorCode } from '../errors';
import type { SandboxError } from '../errors/classes';
import { createTransport, type Transport } from './transport';
import type { HttpClientOptions, ResponseHandler } from './types';

// Container startup retry configuration
const TIMEOUT_MS = 120_000; // 2 minutes total retry budget
const MIN_TIME_FOR_RETRY_MS = 15_000; // Need at least 15s remaining to retry (allows for longer container startups)

/**
 * Abstract base class providing common HTTP/WebSocket functionality for all domain clients
 *
 * Supports two transport modes:
 * - HTTP (default): Each request is a separate HTTP call
 * - WebSocket: All requests multiplexed over a single connection
 *
 * WebSocket mode is useful when running inside Workers/Durable Objects
 * where sub-request limits apply.
 */
export abstract class BaseHttpClient {
  protected baseUrl: string;
  protected options: HttpClientOptions;
  protected logger: Logger;
  protected transport: Transport | null = null;

  constructor(options: HttpClientOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? createNoOpLogger();
    this.baseUrl = this.options.baseUrl!;

    // Use provided transport or create one if WebSocket mode is enabled
    if (options.transport) {
      this.transport = options.transport;
    } else if (options.transportMode === 'websocket' && options.wsUrl) {
      this.transport = createTransport({
        mode: 'websocket',
        wsUrl: options.wsUrl,
        logger: this.logger
      });
    }
  }

  /**
   * Check if using WebSocket transport
   */
  protected isWebSocketMode(): boolean {
    return this.transport?.getMode() === 'websocket';
  }

  /**
   * Core HTTP request method with automatic retry for container startup delays
   * Retries on 503 (Service Unavailable) which indicates container is starting
   *
   * When WebSocket transport is enabled, this creates a Response-like object
   * from the WebSocket response for compatibility with existing code.
   */
  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    // Use WebSocket transport if available
    if (this.transport?.getMode() === 'websocket') {
      return this.doWebSocketFetch(path, options);
    }

    // Fall back to HTTP transport
    return this.doHttpFetch(path, options);
  }

  /**
   * WebSocket-based fetch implementation
   * Converts WebSocket request/response to Response object for compatibility
   */
  private async doWebSocketFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    if (!this.transport) {
      throw new Error('WebSocket transport not initialized');
    }

    const method = (options?.method || 'GET') as
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'DELETE';
    let body: unknown;

    if (options?.body && typeof options.body === 'string') {
      try {
        body = JSON.parse(options.body);
      } catch {
        body = options.body;
      }
    }

    const result = await this.transport.request(method, path, body);

    // Create a Response-like object for compatibility
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * HTTP-based fetch implementation with retry logic
   */
  private async doHttpFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.executeFetch(path, options);

      // Check if this is a retryable container error (503 = transient)
      const shouldRetry = this.isRetryableContainerError(response);

      if (shouldRetry) {
        const elapsed = Date.now() - startTime;
        const remaining = TIMEOUT_MS - elapsed;

        // Check if we have enough time for another attempt
        if (remaining > MIN_TIME_FOR_RETRY_MS) {
          // Exponential backoff with longer delays for container ops: 3s, 6s, 12s, 24s, 30s
          const delay = Math.min(3000 * 2 ** attempt, 30000);

          this.logger.info('Container not ready, retrying', {
            status: response.status,
            attempt: attempt + 1,
            delayMs: delay,
            remainingSec: Math.floor(remaining / 1000)
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt++;
          continue;
        }

        // Timeout exhausted
        this.logger.error(
          'Container failed to become ready',
          new Error(
            `Failed after ${attempt + 1} attempts over ${Math.floor(elapsed / 1000)}s`
          )
        );
        return response;
      }

      // Not a retryable error or request succeeded
      return response;
    }
  }

  /**
   * Make a POST request with JSON body
   */
  protected async post<T>(
    endpoint: string,
    data: unknown,
    responseHandler?: ResponseHandler<T>
  ): Promise<T> {
    const response = await this.doFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    return this.handleResponse(response, responseHandler);
  }

  /**
   * Make a GET request
   */
  protected async get<T>(
    endpoint: string,
    responseHandler?: ResponseHandler<T>
  ): Promise<T> {
    const response = await this.doFetch(endpoint, {
      method: 'GET'
    });

    return this.handleResponse(response, responseHandler);
  }

  /**
   * Make a DELETE request
   */
  protected async delete<T>(
    endpoint: string,
    responseHandler?: ResponseHandler<T>
  ): Promise<T> {
    const response = await this.doFetch(endpoint, {
      method: 'DELETE'
    });

    return this.handleResponse(response, responseHandler);
  }

  /**
   * Handle HTTP response with error checking and parsing
   */
  protected async handleResponse<T>(
    response: Response,
    customHandler?: ResponseHandler<T>
  ): Promise<T> {
    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    if (customHandler) {
      return customHandler(response);
    }

    try {
      return await response.json();
    } catch (error) {
      // Handle malformed JSON responses gracefully
      const errorResponse: NewErrorResponse = {
        code: ErrorCode.INVALID_JSON_RESPONSE,
        message: `Invalid JSON response: ${
          error instanceof Error ? error.message : 'Unknown parsing error'
        }`,
        context: {},
        httpStatus: response.status,
        timestamp: new Date().toISOString()
      };
      throw createErrorFromResponse(errorResponse);
    }
  }

  /**
   * Handle error responses with consistent error throwing
   */
  protected async handleErrorResponse(response: Response): Promise<never> {
    let errorData: NewErrorResponse;

    try {
      errorData = await response.json();
    } catch {
      // Fallback if response isn't JSON or parsing fails
      errorData = {
        code: ErrorCode.INTERNAL_ERROR,
        message: `HTTP error! status: ${response.status}`,
        context: { statusText: response.statusText },
        httpStatus: response.status,
        timestamp: new Date().toISOString()
      };
    }

    // Convert ErrorResponse to appropriate Error class
    const error = createErrorFromResponse(errorData);

    // Call error callback if provided
    this.options.onError?.(errorData.message, undefined);

    throw error;
  }

  /**
   * Create a streaming response handler for Server-Sent Events
   */
  protected async handleStreamResponse(
    response: Response
  ): Promise<ReadableStream<Uint8Array>> {
    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return response.body;
  }

  /**
   * Stream request handler for WebSocket transport
   * Returns a ReadableStream that receives data over WebSocket
   * @param path - The API path to call
   * @param body - Optional request body (for POST requests)
   * @param method - HTTP method (default: POST, use GET for process logs)
   */
  protected async doStreamFetch(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    // Use WebSocket transport if available
    if (this.transport?.getMode() === 'websocket') {
      return this.transport.requestStream(method, path, body);
    }

    // Fall back to HTTP streaming
    const response = await this.doFetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && method === 'POST' ? JSON.stringify(body) : undefined
    });

    return this.handleStreamResponse(response);
  }

  /**
   * Utility method to log successful operations
   */
  protected logSuccess(operation: string, details?: string): void {
    this.logger.info(operation, details ? { details } : undefined);
  }

  /**
   * Utility method to log errors intelligently
   * Only logs unexpected errors (5xx), not expected errors (4xx)
   *
   * - 4xx errors (validation, not found, conflicts): Don't log (expected client errors)
   * - 5xx errors (server failures, internal errors): DO log (unexpected server errors)
   */
  protected logError(operation: string, error: unknown): void {
    // Check if it's a SandboxError with HTTP status
    if (error && typeof error === 'object' && 'httpStatus' in error) {
      const httpStatus = (error as SandboxError).httpStatus;

      // Only log server errors (5xx), not client errors (4xx)
      if (httpStatus >= 500) {
        this.logger.error(
          `Unexpected error in ${operation}`,
          error instanceof Error ? error : new Error(String(error)),
          { httpStatus }
        );
      }
      // 4xx errors are expected (validation, not found, etc.) - don't log
    } else {
      // Non-SandboxError (unexpected) - log it
      this.logger.error(
        `Error in ${operation}`,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Check if response indicates a retryable container error
   *
   * The Sandbox DO returns proper HTTP status codes:
   * - 503 Service Unavailable: Transient errors (container starting, port not ready)
   * - 500 Internal Server Error: Permanent errors (bad config, missing image)
   *
   * We only retry on 503, which indicates the container is starting up.
   * The Retry-After header suggests how long to wait.
   *
   * @param response - HTTP response to check
   * @returns true if error is retryable (503), false otherwise
   */
  private isRetryableContainerError(response: Response): boolean {
    // 503 = transient, retry
    // 500 = permanent, don't retry
    // Everything else = not a container error
    return response.status === 503;
  }

  private async executeFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = this.options.stub
      ? `http://localhost:${this.options.port}${path}`
      : `${this.baseUrl}${path}`;

    try {
      if (this.options.stub) {
        return await this.options.stub.containerFetch(
          url,
          options || {},
          this.options.port
        );
      } else {
        return await fetch(url, options);
      }
    } catch (error) {
      this.logger.error(
        'HTTP request error',
        error instanceof Error ? error : new Error(String(error)),
        { method: options?.method || 'GET', url }
      );
      throw error;
    }
  }
}
