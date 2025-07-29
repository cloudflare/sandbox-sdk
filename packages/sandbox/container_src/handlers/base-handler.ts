// Base Handler Implementation
import type { Handler, RequestContext, Logger, ServiceResult, ServiceError } from '../core/types';

export abstract class BaseHandler<TRequest, TResponse> implements Handler<TRequest, TResponse> {
  constructor(
    protected logger: Logger
  ) {}

  abstract handle(request: TRequest, context: RequestContext): Promise<TResponse>;

  protected createSuccessResponse<T>(data: T, context: RequestContext, statusCode: number = 200): Response {
    return new Response(
      JSON.stringify({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      }),
      {
        status: statusCode,
        headers: {
          'Content-Type': 'application/json',
          ...context.corsHeaders,
        },
      }
    );
  }

  protected createErrorResponse(
    error: ServiceError | Error | string, 
    statusCode: number = 500,
    context: RequestContext
  ): Response {
    let errorObj: ServiceError;

    if (typeof error === 'string') {
      errorObj = {
        message: error,
        code: 'UNKNOWN_ERROR',
      };
    } else if (error instanceof Error) {
      errorObj = {
        message: error.message,
        code: 'INTERNAL_ERROR',
        details: { stack: error.stack },
      };
    } else {
      errorObj = error;
    }

    this.logger.error('Handler error', error instanceof Error ? error : undefined, {
      requestId: context.requestId,
      errorCode: errorObj.code,
      statusCode,
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: errorObj.message,
        code: errorObj.code,
        details: errorObj.details,
        timestamp: new Date().toISOString(),
      }),
      {
        status: statusCode,
        headers: {
          'Content-Type': 'application/json',
          ...context.corsHeaders,
        },
      }
    );
  }

  protected createServiceResponse<T>(
    result: ServiceResult<T>,
    context: RequestContext,
    successStatus: number = 200
  ): Response {
    if (result.success) {
      return this.createSuccessResponse(result.data, context, successStatus);
    } else {
      const statusCode = this.getStatusCodeForError(result.error!.code);
      return this.createErrorResponse(result.error!, statusCode, context);
    }
  }

  private getStatusCodeForError(errorCode: string): number {
    const statusCodeMap: Record<string, number> = {
      'NOT_FOUND': 404,
      'PROCESS_NOT_FOUND': 404,
      'SESSION_NOT_FOUND': 404,
      'PORT_NOT_FOUND': 404,
      'FILE_NOT_FOUND': 404,
      'INVALID_REQUEST': 400,
      'VALIDATION_ERROR': 400,
      'INVALID_PATH': 400,
      'INVALID_PORT': 400,
      'INVALID_COMMAND': 400,
      'SECURITY_VIOLATION': 403,
      'PATH_SECURITY_VIOLATION': 403,
      'COMMAND_SECURITY_VIOLATION': 403,
      'PORT_ALREADY_EXPOSED': 409,
      'SESSION_EXPIRED': 401,
      'UNAUTHORIZED': 401,
      'TIMEOUT': 408,
    };

    return statusCodeMap[errorCode] || 500;
  }

  protected async parseRequestBody<T>(request: Request): Promise<T> {
    try {
      const body = await request.json();
      return body as T;
    } catch (error) {
      throw new Error('Invalid JSON in request body');
    }
  }

  protected extractPathParam(pathname: string, position: number): string {
    const segments = pathname.split('/');
    return segments[position] || '';
  }

  protected extractQueryParam(request: Request, param: string): string | null {
    const url = new URL(request.url);
    return url.searchParams.get(param);
  }
}