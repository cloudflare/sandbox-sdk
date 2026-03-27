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
      const durationMs = Date.now() - startTime;
      const isError = statusCode >= 500 || Boolean(requestError);

      const wideEvent: Record<string, unknown> = {
        method,
        pathname,
        statusCode,
        durationMs,
        requestId: context.requestId,
        sessionId: context.sessionId,
        sandboxId: context.sandboxId
      };

      const msg = `${method} ${pathname} ${statusCode}`;
      if (statusCode >= 500) {
        this.logger.warn(msg, { ...wideEvent, error: requestError?.message });
      } else {
        this.logger.debug(msg, wideEvent);
      }
    }
  }
}
