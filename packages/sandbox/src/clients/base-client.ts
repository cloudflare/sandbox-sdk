import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { getHttpStatus } from '@repo/shared/errors';
import type { ErrorResponse as NewErrorResponse } from '../errors';
import { createErrorFromResponse, ErrorCode } from '../errors';
import type { SandboxError } from '../errors/classes';
import type { HttpClientOptions, ResponseHandler } from './types';

// Container startup retry configuration
const TIMEOUT_MS = 120_000; // 2 minutes total retry budget
const MIN_TIME_FOR_RETRY_MS = 15_000; // Need at least 15s remaining to retry (allows for longer container startups)

/**
 * Abstract base class providing common HTTP functionality for all domain clients
 */
export abstract class BaseHttpClient {
  protected baseUrl: string;
  protected options: HttpClientOptions;
  protected logger: Logger;

  constructor(options: HttpClientOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? createNoOpLogger();
    this.baseUrl = this.options.baseUrl!;
  }

  /**
   * Core HTTP request method with automatic retry for container startup delays
   * Retries both 503 (provisioning) and 500 (startup failure) errors when they're container-related
   */
  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.executeFetch(path, options);

      // Check if this is a retryable container error (both 500 and 503)
      const shouldRetry = await this.isRetryableContainerError(response);

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
   * Utility method to log successful operations
   */
  protected logSuccess(operation: string, details?: string): void {
    this.logger.info(
      `${operation} completed successfully`,
      details ? { details } : undefined
    );
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
   * Uses fail-safe strategy: only retry known transient errors
   *
   * TODO: This relies on string matching error messages, which is brittle.
   * Ideally, the container API should return structured errors with a
   * `retryable: boolean` field to avoid coupling to error message format.
   *
   * @param response - HTTP response to check
   * @returns true if error is retryable container error, false otherwise
   */
  private async isRetryableContainerError(
    response: Response
  ): Promise<boolean> {
    // Only consider 500 and 503 status codes
    if (response.status !== 500 && response.status !== 503) {
      return false;
    }

    try {
      const cloned = response.clone();
      const text = await cloned.text();
      const textLower = text.toLowerCase();

      // Step 1: Check for permanent errors (fail fast)
      const permanentErrors = [
        'no such image', // Missing Docker image
        'container already exists', // Name collision
        'malformed containerinspect' // Docker API issue
      ];

      if (permanentErrors.some((err) => textLower.includes(err))) {
        this.logger.debug('Detected permanent error, not retrying', { text });
        return false; // Don't retry
      }

      // Step 2: Check for known transient errors (do retry)
      const transientErrors = [
        // Platform provisioning (503)
        'no container instance available',
        'currently provisioning',

        // Port mapping race conditions (500)
        'container port not found',
        'connection refused: container port',

        // Application startup delays (500)
        'the container is not listening',
        'failed to verify port',
        'container did not start',

        // Network transients (500)
        'network connection lost',
        'container suddenly disconnected',

        // Monitor race conditions (500)
        'monitor failed to find container',

        // General timeouts (500)
        'timed out',
        'timeout'
      ];

      const shouldRetry = transientErrors.some((err) =>
        textLower.includes(err)
      );

      if (!shouldRetry) {
        this.logger.debug('Unknown error pattern, not retrying', {
          status: response.status,
          text: text.substring(0, 200) // Log first 200 chars
        });
      }

      return shouldRetry;
    } catch (error) {
      this.logger.error(
        'Error checking if response is retryable',
        error instanceof Error ? error : new Error(String(error))
      );
      // If we can't read response, don't retry (fail fast)
      return false;
    }
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
