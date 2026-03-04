// Logging Middleware
import type { Logger } from '@repo/shared';
import type { Middleware, NextFunction, RequestContext } from '../core/types';

export class LoggingMiddleware implements Middleware {
  constructor(private logger: Logger) {}

  async handle(
    request: Request,
    context: RequestContext,
    next: NextFunction
  ): Promise<Response> {
    const startTime = Date.now();
    const method = request.method;
    const url = new URL(request.url);
    const pathname = url.pathname;
    const contentLength = request.headers.get('content-length');
    const requestEvent: Record<string, unknown> = {
      requestId: context.requestId,
      method,
      pathname,
      sessionId: context.sessionId,
      startedAt: context.timestamp.toISOString(),
      userAgent: request.headers.get('user-agent') ?? undefined,
      contentLength: contentLength ? Number(contentLength) : undefined
    };

    let response: Response | undefined;
    let requestError: Error | undefined;

    try {
      response = await next();
      return response;
    } catch (error) {
      requestError =
        error instanceof Error ? error : new Error('Unknown request failure');
      throw error;
    } finally {
      const statusCode = response?.status ?? 500;
      const duration = Date.now() - startTime;
      const isError = statusCode >= 500 || Boolean(requestError);
      const wideEvent = {
        ...requestEvent,
        statusCode,
        durationMs: duration,
        outcome: isError ? 'error' : 'success'
      };

      const msg = `${method} ${pathname}`;
      if (isError) {
        this.logger.error(msg, requestError, wideEvent);
      } else {
        this.logger.info(msg, wideEvent);
      }
    }
  }
}
