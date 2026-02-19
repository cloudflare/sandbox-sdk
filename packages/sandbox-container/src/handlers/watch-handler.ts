import type { Logger, WatchRequest } from '@repo/shared';
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
    return this.handleWatch(request, context);
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
}
