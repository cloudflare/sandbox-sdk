// Miscellaneous Handler for ping, commands, etc.
import type { HealthCheckResult, Logger, ShutdownResult } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
import { BaseHandler } from './base-handler';

export class MiscHandler extends BaseHandler<Request, Response> {

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/':
        return await this.handleRoot(request, context);
      case '/api/health':
        return await this.handleHealth(request, context);
      case '/api/shutdown':
        return await this.handleShutdown(request, context);
      default:
        return this.createErrorResponse({
          message: 'Invalid endpoint',
          code: ErrorCode.UNKNOWN_ERROR,
        }, context);
    }
  }

  private async handleRoot(request: Request, context: RequestContext): Promise<Response> {
    return new Response('Hello from Bun server! 🚀', {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...context.corsHeaders,
      },
    });
  }

  private async handleHealth(request: Request, context: RequestContext): Promise<Response> {
    const response: HealthCheckResult = {
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };

    return this.createTypedResponse(response, context);
  }

  private async handleShutdown(request: Request, context: RequestContext): Promise<Response> {
    const response: ShutdownResult = {
      success: true,
      message: 'Container shutdown initiated',
      timestamp: new Date().toISOString(),
    };

    return this.createTypedResponse(response, context);
  }
}