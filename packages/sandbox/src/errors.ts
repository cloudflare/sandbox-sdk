/**
 * Standard error response from the sandbox API
 */
export interface SandboxErrorResponse {
  error?: string;
  status?: string;
  progress?: number;
}

/**
 * Base error class for all Sandbox-related errors
 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when Jupyter functionality is requested but the service is still initializing.
 *
 * Note: With the current implementation, requests wait for Jupyter to be ready.
 * This error is only thrown when:
 * 1. The request times out waiting for Jupyter (default: 30 seconds)
 * 2. Jupyter initialization actually fails
 *
 * Most requests will succeed after a delay, not throw this error.
 */
export class JupyterNotReadyError extends SandboxError {
  public readonly code = "JUPYTER_NOT_READY";
  public readonly retryAfter: number;
  public readonly progress?: number;

  constructor(
    message?: string,
    options?: { retryAfter?: number; progress?: number }
  ) {
    super(
      message || "Jupyter is still initializing. Please retry in a few seconds."
    );
    this.retryAfter = options?.retryAfter || 5;
    this.progress = options?.progress;
  }
}

/**
 * Error thrown when a context is not found
 */
export class ContextNotFoundError extends SandboxError {
  public readonly code = "CONTEXT_NOT_FOUND";
  public readonly contextId: string;

  constructor(contextId: string) {
    super(`Context ${contextId} not found`);
    this.contextId = contextId;
  }
}

/**
 * Error thrown when code execution fails
 */
export class CodeExecutionError extends SandboxError {
  public readonly code = "CODE_EXECUTION_ERROR";
  public readonly executionError?: {
    ename?: string;
    evalue?: string;
    traceback?: string[];
  };

  constructor(message: string, executionError?: any) {
    super(message);
    this.executionError = executionError;
  }
}

/**
 * Error thrown when the sandbox container is not ready
 */
export class ContainerNotReadyError extends SandboxError {
  public readonly code = "CONTAINER_NOT_READY";

  constructor(message?: string) {
    super(
      message ||
        "Container is not ready. Please wait for initialization to complete."
    );
  }
}

/**
 * Error thrown when a network request to the sandbox fails
 */
export class SandboxNetworkError extends SandboxError {
  public readonly code = "NETWORK_ERROR";
  public readonly statusCode?: number;
  public readonly statusText?: string;

  constructor(message: string, statusCode?: number, statusText?: string) {
    super(message);
    this.statusCode = statusCode;
    this.statusText = statusText;
  }
}

/**
 * Error thrown when service is temporarily unavailable (e.g., circuit breaker open)
 */
export class ServiceUnavailableError extends SandboxError {
  public readonly code = "SERVICE_UNAVAILABLE";
  public readonly retryAfter?: number;

  constructor(message?: string, retryAfter?: number) {
    // Simple, user-friendly message without implementation details
    super(message || "Service temporarily unavailable");
    this.retryAfter = retryAfter;
  }
}

/**
 * Type guard to check if an error is a JupyterNotReadyError
 */
export function isJupyterNotReadyError(
  error: unknown
): error is JupyterNotReadyError {
  return error instanceof JupyterNotReadyError;
}

/**
 * Type guard to check if an error is any SandboxError
 */
export function isSandboxError(error: unknown): error is SandboxError {
  return error instanceof SandboxError;
}

/**
 * Helper to determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (
    error instanceof JupyterNotReadyError ||
    error instanceof ContainerNotReadyError ||
    error instanceof ServiceUnavailableError
  ) {
    return true;
  }

  if (error instanceof SandboxNetworkError) {
    // Retry on 502, 503, 504 (gateway/service unavailable errors)
    return error.statusCode
      ? [502, 503, 504].includes(error.statusCode)
      : false;
  }

  return false;
}

/**
 * Parse error response from the sandbox API and return appropriate error instance
 */
export async function parseErrorResponse(
  response: Response
): Promise<SandboxError> {
  let data: SandboxErrorResponse;

  try {
    data = (await response.json()) as SandboxErrorResponse;
  } catch {
    // If JSON parsing fails, return a generic network error
    return new SandboxNetworkError(
      `Request failed with status ${response.status}`,
      response.status,
      response.statusText
    );
  }

  // Check for specific error types based on response
  if (response.status === 503) {
    // Circuit breaker error
    if (data.status === "circuit_open") {
      return new ServiceUnavailableError(
        "Service temporarily unavailable",
        parseInt(response.headers.get("Retry-After") || "30")
      );
    }

    // Jupyter initialization error
    if (data.status === "initializing") {
      return new JupyterNotReadyError(data.error, {
        retryAfter: parseInt(response.headers.get("Retry-After") || "5"),
        progress: data.progress,
      });
    }
  }

  // Check for context not found
  if (
    response.status === 404 &&
    data.error?.includes("Context") &&
    data.error?.includes("not found")
  ) {
    const contextId =
      data.error.match(/Context (\S+) not found/)?.[1] || "unknown";
    return new ContextNotFoundError(contextId);
  }

  // Default network error
  return new SandboxNetworkError(
    data.error || `Request failed with status ${response.status}`,
    response.status,
    response.statusText
  );
}
