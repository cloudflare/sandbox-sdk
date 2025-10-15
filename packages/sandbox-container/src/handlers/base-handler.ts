import {
  type ErrorCode,
  type ErrorResponse,
  getHttpStatus,
  getSuggestion,
  type OperationType,
} from "@repo/shared/errors";
import type {
  Handler,
  Logger,
  RequestContext,
  ServiceError,
} from "../core/types";

export abstract class BaseHandler<TRequest, TResponse>
  implements Handler<TRequest, TResponse>
{
  constructor(protected logger: Logger) {}

  abstract handle(
    request: TRequest,
    context: RequestContext
  ): Promise<TResponse>;

  /**
   * Create HTTP response from typed response data
   * Type parameter ensures response matches a valid result interface from @repo/shared
   */
  protected createTypedResponse<T extends { success: boolean }>(
    responseData: T,
    context: RequestContext,
    statusCode: number = 200
  ): Response {
    return new Response(JSON.stringify(responseData), {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        ...context.corsHeaders,
      },
    });
  }

  /**
   * Create HTTP response from ServiceError
   * Enriches error with HTTP status, suggestions, etc.
   */
  protected createErrorResponse(
    serviceError: ServiceError,
    context: RequestContext,
    operation?: OperationType
  ): Response {
    const errorResponse = this.enrichServiceError(serviceError, operation);
    return new Response(JSON.stringify(errorResponse), {
      status: errorResponse.httpStatus,
      headers: {
        "Content-Type": "application/json",
        ...context.corsHeaders,
      },
    });
  }

  /**
   * Enrich lightweight ServiceError into full ErrorResponse
   * Adds HTTP status, timestamp, suggestions, operation, etc.
   */
  protected enrichServiceError(
    serviceError: ServiceError,
    operation?: OperationType
  ): ErrorResponse {
    const errorCode = serviceError.code as ErrorCode;
    return {
      code: errorCode,
      message: serviceError.message,
      context: serviceError.details || {},
      operation: operation || (serviceError.details?.operation as OperationType | undefined),
      httpStatus: getHttpStatus(errorCode),
      timestamp: new Date().toISOString(),
      suggestion: getSuggestion(errorCode, serviceError.details || {}),
    };
  }

  /**
   * Parse and return request body as JSON
   * Throws if body is missing or invalid JSON
   */
  protected async parseRequestBody<T>(request: Request): Promise<T> {
    try {
      const body = await request.json();
      return body as T;
    } catch (error) {
      throw new Error(
        `Failed to parse request body: ${error instanceof Error ? error.message : 'Invalid JSON'}`
      );
    }
  }

  protected extractPathParam(pathname: string, position: number): string {
    const segments = pathname.split("/");
    return segments[position] || "";
  }

  protected extractQueryParam(request: Request, param: string): string | null {
    const url = new URL(request.url);
    return url.searchParams.get(param);
  }
}
