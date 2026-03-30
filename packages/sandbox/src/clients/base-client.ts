import type { Logger } from '@repo/shared';
import { createNoOpLogger, DEFAULT_CONTROL_PORT } from '@repo/shared';
import type { ErrorResponse as NewErrorResponse } from '../errors';
import { createErrorFromResponse, ErrorCode } from '../errors';
import { createTransport, type ITransport } from './transport';
import type { HttpClientOptions, ResponseHandler } from './types';

/**
 * Abstract base class providing common HTTP/WebSocket functionality for all domain clients
 *
 * All requests go through the Transport abstraction layer, which handles:
 * - HTTP and WebSocket modes transparently
 * - Automatic retry for 503 errors (container starting)
 * - Streaming responses
 *
 * WebSocket mode is useful when running inside Workers/Durable Objects
 * where sub-request limits apply.
 */
export abstract class BaseHttpClient {
  protected options: HttpClientOptions;
  protected logger: Logger;
  protected transport: ITransport;

  constructor(options: HttpClientOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? createNoOpLogger();

    // Always create a Transport - it handles both HTTP and WebSocket modes
    if (options.transport) {
      this.transport = options.transport;
    } else {
      const mode = options.transportMode ?? 'http';
      this.transport = createTransport({
        mode,
        baseUrl:
          options.baseUrl ??
          `http://localhost:${options.port ?? DEFAULT_CONTROL_PORT}`,
        wsUrl: options.wsUrl,
        logger: this.logger,
        stub: options.stub,
        port: options.port,
        retryTimeoutMs: options.retryTimeoutMs
      });
    }
  }

  /**
   * Update the transport's 503 retry budget
   */
  setRetryTimeoutMs(ms: number): void {
    this.transport.setRetryTimeoutMs(ms);
  }

  /**
   * Check if using WebSocket transport
   */
  protected isWebSocketMode(): boolean {
    return this.transport.getMode() === 'websocket';
  }

  /**
   * Core fetch method - delegates to Transport which handles retry logic
   */
  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const { defaultHeaders } = this.options;
    if (defaultHeaders) {
      options = {
        ...options,
        headers: {
          ...defaultHeaders,
          ...(options?.headers as Record<string, string> | undefined)
        }
      };
    }
    return this.transport.fetch(path, options);
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
   * Stream request handler
   *
   * For HTTP mode, uses doFetch + handleStreamResponse to get proper error typing.
   * For WebSocket mode, uses Transport's streaming support.
   *
   * @param path - The API path to call
   * @param body - Optional request body (for POST requests)
   * @param method - HTTP method (default: POST, use GET for process logs)
   */
  protected async doStreamFetch(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    const streamHeaders =
      method === 'POST'
        ? {
            ...this.options.defaultHeaders,
            'Content-Type': 'application/json'
          }
        : this.options.defaultHeaders;

    // WebSocket mode uses Transport's streaming directly
    if (this.transport.getMode() === 'websocket') {
      return this.transport.fetchStream(path, body, method, streamHeaders);
    }

    // HTTP mode: use doFetch + handleStreamResponse for proper error typing
    const response = await this.doFetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && method === 'POST' ? JSON.stringify(body) : undefined
    });

    return this.handleStreamResponse(response);
  }
}
