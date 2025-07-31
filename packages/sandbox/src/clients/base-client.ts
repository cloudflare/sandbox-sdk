import { mapContainerError } from '../utils/error-mapping';
import type {
  ErrorResponse,
  HttpClientOptions,
  ResponseHandler
} from './types';

/**
 * Abstract base class providing common HTTP functionality for all domain clients
 */
export abstract class BaseHttpClient {
  protected baseUrl: string;
  protected options: HttpClientOptions;
  protected sessionId: string | null = null;
  private isTestEnvironment: boolean;

  constructor(options: HttpClientOptions = {}) {
    this.options = {
      ...options,
    };
    this.baseUrl = this.options.baseUrl!;
    
    // Detect test environment to reduce logging noise
    this.isTestEnvironment = 
      process.env.NODE_ENV === 'test' || 
      process.env.VITEST === 'true' ||
      'expect' in globalThis; // Vitest globals check
  }

  /**
   * Core HTTP request method with error handling and logging
   */
  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = this.options.stub
      ? `http://localhost:${this.options.port}${path}`
      : `${this.baseUrl}${path}`;
    const method = options?.method || "GET";

    // Only log HTTP details in non-test environments
    if (!this.isTestEnvironment) {
      console.log(`[HTTP Client] Making ${method} request to ${url}`);
    }

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

      if (!this.isTestEnvironment) {
        console.log(
          `[HTTP Client] Response: ${response.status} ${response.statusText}`
        );
      }

      if (!response.ok && !this.isTestEnvironment) {
        console.error(
          `[HTTP Client] Request failed: ${method} ${url} - ${response.status} ${response.statusText}`
        );
      }

      return response;
    } catch (error) {
      if (!this.isTestEnvironment) {
        console.error(`[HTTP Client] Request error: ${method} ${url}`, error);
      }
      throw error;
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
      throw mapContainerError({
        error: `Invalid JSON response: ${error instanceof Error ? error.message : 'Unknown parsing error'}`,
        code: 'INVALID_JSON_RESPONSE'
      });
    }
  }

  /**
   * Handle error responses with consistent error throwing
   */
  protected async handleErrorResponse(response: Response): Promise<never> {
    let errorData: ErrorResponse & { code?: string; operation?: import('../errors').SandboxOperationType; path?: string };

    try {
      errorData = await response.json();
    } catch {
      errorData = {
        error: `HTTP error! status: ${response.status}`,
        details: response.statusText
      };
    }

    // Map to specific error types if possible
    const error = mapContainerError(errorData);

    // Call error callback if provided
    this.options.onError?.(errorData.error, undefined);

    throw error;
  }

  /**
   * Include session ID in request data if available
   */
  protected withSession(data: Record<string, any>, sessionId?: string): Record<string, any> {
    const targetSessionId = sessionId || this.sessionId;

    if (targetSessionId) {
      return { ...data, sessionId: targetSessionId };
    }

    return data;
  }

  /**
   * Set the session ID for subsequent requests
   */
  public setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /**
   * Get the current session ID
   */
  public getSessionId(): string | null {
    return this.sessionId;
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
    if (!this.isTestEnvironment) {
      const message = details
        ? `[HTTP Client] ${operation}: ${details}`
        : `[HTTP Client] ${operation} completed successfully`;
      console.log(message);
    }
  }

  /**
   * Utility method to log errors
   */
  protected logError(operation: string, error: unknown): void {
    if (!this.isTestEnvironment) {
      console.error(`[HTTP Client] Error in ${operation}:`, error);
    }
  }
}