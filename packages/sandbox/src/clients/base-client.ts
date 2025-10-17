import type { ErrorResponse as NewErrorResponse } from '../errors';
import { createErrorFromResponse, ErrorCode } from '../errors';
import type {
  HttpClientOptions,
  ResponseHandler
} from './types';

// Container provisioning retry configuration
const TIMEOUT_MS = 60_000;  // 60 seconds total timeout budget
const MIN_TIME_FOR_RETRY_MS = 10_000;  // Need at least 10s remaining to retry (8s Container + 2s delay)

/**
 * Abstract base class providing common HTTP functionality for all domain clients
 */
export abstract class BaseHttpClient {
  protected baseUrl: string;
  protected options: HttpClientOptions;

  constructor(options: HttpClientOptions = {}) {
    this.options = {
      ...options,
    };
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

    console.log(`[DEBUG] doFetch called for ${options?.method || 'GET'} ${path}`);

    while (true) {
      const response = await this.executeFetch(path, options);

      console.log(`[DEBUG] Response status: ${response.status}`);

      // Only retry container provisioning 503s, not user app 503s
      if (response.status === 503) {
        console.log('[DEBUG] Got 503 response, checking if container provisioning error...');

        const isContainerProvisioning = await this.isContainerProvisioningError(response);

        console.log('[DEBUG] isContainerProvisioning result:', isContainerProvisioning);

        if (isContainerProvisioning) {
          const elapsed = Date.now() - startTime;
          const remaining = TIMEOUT_MS - elapsed;

          console.log(`[DEBUG] Elapsed: ${elapsed}ms, Remaining: ${remaining}ms`);

          // Check if we have enough time for another attempt
          // (Need at least 10s: 8s for Container timeout + 2s delay)
          if (remaining > MIN_TIME_FOR_RETRY_MS) {
            // Exponential backoff: 2s, 4s, 8s, 16s (capped at 16s)
            const delay = Math.min(2000 * 2 ** attempt, 16000);

            console.log(
              `[Sandbox SDK] Container provisioning in progress (attempt ${attempt + 1}), ` +
              `retrying in ${delay}ms (${Math.floor(remaining / 1000)}s remaining)`
            );

            await new Promise(resolve => setTimeout(resolve, delay));
            attempt++;
            continue;
          } else {
            // Exhausted retries - log error and return response
            // Let existing error handling convert to proper error
            console.error(
              `[Sandbox SDK] Container failed to provision after ${attempt + 1} attempts over 60s.`
            );
            return response;
          }
        } else {
          console.log('[DEBUG] Not a container provisioning error, returning 503 immediately');
        }
      }

      // Return response (success, user app error, or non-retryable error)
      if (response.status !== 200) {
        console.log(`[DEBUG] Returning response with status ${response.status}`);
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
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
      method: 'GET',
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
      method: 'DELETE',
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
        message: `Invalid JSON response: ${error instanceof Error ? error.message : 'Unknown parsing error'}`,
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
    const message = details
      ? `[HTTP Client] ${operation}: ${details}`
      : `[HTTP Client] ${operation} completed successfully`;
    console.log(message);
  }

  /**
   * Utility method to log errors
   */
  protected logError(operation: string, error: unknown): void {
    console.error(`[HTTP Client] Error in ${operation}:`, error);
  }

  /**
   * Check if 503 response is from container provisioning (retryable)
   * vs user application (not retryable)
   */
  private async isContainerProvisioningError(response: Response): Promise<boolean> {
    try {
      // Clone response so we don't consume the original body
      const cloned = response.clone();
      const text = await cloned.text();

      console.log('[DEBUG] 503 response body:', text.substring(0, 200));

      // Container package returns specific message for provisioning errors
      const isProvisioning = text.includes('There is no Container instance available');

      console.log('[DEBUG] Is container provisioning error?', isProvisioning);

      return isProvisioning;
    } catch (error) {
      console.error('[DEBUG] Error checking response body:', error);
      // If we can't read the body, don't retry to be safe
      return false;
    }
  }

  private async executeFetch(path: string, options?: RequestInit): Promise<Response> {
    const url = this.options.stub
      ? `http://localhost:${this.options.port}${path}`
      : `${this.baseUrl}${path}`;
    const method = options?.method || "GET";

    console.log(`[HTTP Client] Making ${method} request to ${url}`);

    try {
      let response: Response;

      if (this.options.stub) {
        response = await this.options.stub.containerFetch(
          url,
          options || {},
          this.options.port
        );
      } else {
        response = await fetch(url, options);
      }

      console.log(
        `[HTTP Client] Response: ${response.status} ${response.statusText}`
      );

      if (!response.ok) {
        console.error(
          `[HTTP Client] Request failed: ${method} ${url} - ${response.status} ${response.statusText}`
        );
      }

      return response;
    } catch (error) {
      console.error(`[HTTP Client] Request error: ${method} ${url}`, error);
      throw error;
    }
  }
}
