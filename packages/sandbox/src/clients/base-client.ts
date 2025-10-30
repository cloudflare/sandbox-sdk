import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { getHttpStatus } from '@repo/shared/errors';
import type { ErrorResponse as NewErrorResponse } from '../errors';
import { createErrorFromResponse, ErrorCode } from '../errors';
import type { SandboxError } from '../errors/classes';
import type { HttpClientOptions, ResponseHandler } from './types';

// Container provisioning retry configuration
const TIMEOUT_MS = 60_000; // 60 seconds total timeout budget
const MIN_TIME_FOR_RETRY_MS = 10_000; // Need at least 10s remaining to retry (8s Container + 2s delay)

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
   * Core HTTP request method with automatic retry for container provisioning delays
   */
  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.executeFetch(path, options);

      // Only retry container provisioning 503s, not user app 503s
      if (response.status === 503) {
        const isContainerProvisioning =
          await this.isContainerProvisioningError(response);

        if (isContainerProvisioning) {
          const elapsed = Date.now() - startTime;
          const remaining = TIMEOUT_MS - elapsed;

          // Check if we have enough time for another attempt
          // (Need at least 10s: 8s for Container timeout + 2s delay)
          if (remaining > MIN_TIME_FOR_RETRY_MS) {
            // Exponential backoff: 2s, 4s, 8s, 16s (capped at 16s)
            const delay = Math.min(2000 * 2 ** attempt, 16000);

            this.logger.info('Container provisioning in progress, retrying', {
              attempt: attempt + 1,
              delayMs: delay,
              remainingSec: Math.floor(remaining / 1000)
            });

            await new Promise((resolve) => setTimeout(resolve, delay));
            attempt++;
            continue;
          } else {
            // Exhausted retries - log error and return response
            // Let existing error handling convert to proper error
            this.logger.error(
              'Container failed to provision after multiple attempts',
              new Error(`Failed after ${attempt + 1} attempts over 60s`)
            );
            return response;
          }
        }
      }

      return response;
    }
  }

  /**
   * Make a POST request with JSON body
   */
  protected async post<T>(
    endpoint: string,
    data: Record<string, any>,
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
   * Check if 503 response is from container provisioning (retryable)
   * vs user application (not retryable)
   */
  private async isContainerProvisioningError(
    response: Response
  ): Promise<boolean> {
    try {
      // Clone response so we don't consume the original body
      const cloned = response.clone();
      const text = await cloned.text();

      // Container package returns specific message for provisioning errors
      return text.includes('There is no Container instance available');
    } catch (error) {
      this.logger.error(
        'Error checking response body',
        error instanceof Error ? error : new Error(String(error))
      );
      // If we can't read the body, don't retry to be safe
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
