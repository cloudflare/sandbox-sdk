/**
 * Snapshot Handler
 *
 * HTTP handler for directory snapshot operations (create and apply).
 * Returns SSE streams for real-time progress feedback.
 */

import type {
  ApplySnapshotRequest,
  CreateSnapshotRequest,
  Logger,
  SnapshotEvent
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { RequestContext } from '../core/types';
import type { SnapshotService } from '../services/snapshot-service';
import { BaseHandler } from './base-handler';

export class SnapshotHandler extends BaseHandler<Request, Response> {
  constructor(
    private snapshotService: SnapshotService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/api/snapshot/create':
        return this.handleCreateSnapshot(request, context);
      case '/api/snapshot/apply':
        return this.handleApplySnapshot(request, context);
      default:
        return this.createErrorResponse(
          {
            message: 'Invalid snapshot endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  private async handleCreateSnapshot(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const requestLogger = this.createRequestLogger(request, 'snapshot.create');

    try {
      const body = await this.parseRequestBody<CreateSnapshotRequest>(request);

      requestLogger.info('Starting snapshot creation', {
        directory: body.directory,
        compressionLevel: body.compressionLevel
      });

      const events = this.snapshotService.createSnapshot({
        ...body,
        sessionId: body.sessionId || context.sessionId
      });

      return this.createSSEResponse(events, context);
    } catch (error) {
      requestLogger.error(
        'Failed to start snapshot creation',
        error instanceof Error ? error : undefined
      );
      return this.createErrorResponse(
        {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to create snapshot',
          code: ErrorCode.UNKNOWN_ERROR
        },
        context
      );
    }
  }

  private async handleApplySnapshot(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const requestLogger = this.createRequestLogger(request, 'snapshot.apply');

    try {
      const body = await this.parseRequestBody<ApplySnapshotRequest>(request);

      requestLogger.info('Starting snapshot apply', {
        targetDirectory: body.targetDirectory
      });

      const events = this.snapshotService.applySnapshot({
        ...body,
        sessionId: body.sessionId || context.sessionId
      });

      return this.createSSEResponse(events, context);
    } catch (error) {
      requestLogger.error(
        'Failed to start snapshot apply',
        error instanceof Error ? error : undefined
      );
      return this.createErrorResponse(
        {
          message:
            error instanceof Error ? error.message : 'Failed to apply snapshot',
          code: ErrorCode.UNKNOWN_ERROR
        },
        context
      );
    }
  }

  /**
   * Create an SSE response from an async generator of events
   */
  private createSSEResponse(
    events: AsyncGenerator<SnapshotEvent>,
    context: RequestContext
  ): Response {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of events) {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(data));
          }
          // Signal stream completion
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          // Emit error event before closing
          const errorEvent: SnapshotEvent = {
            type: 'error',
            operation: 'create', // Default, actual operation is in the event stream
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString()
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...context.corsHeaders
      }
    });
  }
}
