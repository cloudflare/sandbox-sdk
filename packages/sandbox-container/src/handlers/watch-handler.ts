import type { Logger, WatchRequest, WatchStopResult } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { RequestContext } from '../core/types';
import type { WatchService } from '../services/watch-service';
import { BaseHandler } from './base-handler';

/**
 * Handler for file watch operations
 */
export class WatchHandler extends BaseHandler<Request, Response> {
  constructor(
    private watchService: WatchService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/watch':
        return this.handleWatch(request, context);
      case '/api/watch/stop':
        return this.handleStopWatch(request, context);
      case '/api/watch/list':
        return this.handleListWatches(request, context);
      default:
        return this.createErrorResponse(
          {
            message: 'Invalid watch endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  /**
   * Start watching a directory
   * Returns an SSE stream of file change events
   */
  private async handleWatch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<WatchRequest>(request);

    // Resolve path - if relative, resolve from /workspace
    let watchPath = body.path;
    if (!watchPath.startsWith('/')) {
      watchPath = `/workspace/${watchPath}`;
    }

    const result = await this.watchService.watchDirectory(watchPath, {
      ...body,
      path: watchPath
    });

    if (result.success) {
      return new Response(result.data, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...context.corsHeaders
        }
      });
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  /**
   * Stop a specific watch by ID
   */
  private async handleStopWatch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<{ watchId: string }>(request);

    const result = await this.watchService.stopWatch(body.watchId);

    if (result.success) {
      const response: WatchStopResult = {
        success: true,
        watchId: body.watchId,
        timestamp: new Date().toISOString()
      };
      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  /**
   * List all active watches
   */
  private async handleListWatches(
    _request: Request,
    context: RequestContext
  ): Promise<Response> {
    const watches = this.watchService.getActiveWatches();

    const response = {
      success: true,
      watches: watches.map((w) => ({
        id: w.id,
        path: w.path,
        startedAt: w.startedAt.toISOString()
      })),
      count: watches.length,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }
}
