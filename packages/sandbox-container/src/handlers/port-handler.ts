// Port Handler
import type { Logger, PortWatchEvent, PortWatchRequest } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
import type { PortService } from '../services/port-service';
import type { ProcessService } from '../services/process-service';
import { BaseHandler } from './base-handler';

export class PortHandler extends BaseHandler<Request, Response> {
  constructor(
    private portService: PortService,
    private processService: ProcessService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api/port-watch') {
      return await this.handlePortWatch(request, context);
    }

    return this.createErrorResponse(
      {
        message: 'Invalid port endpoint',
        code: ErrorCode.UNKNOWN_ERROR
      },
      context
    );
  }

  private async handlePortWatch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<PortWatchRequest>(request);
    const {
      port,
      mode,
      path,
      statusMin,
      statusMax,
      processId,
      interval = 500
    } = body;

    const portService = this.portService;
    const processService = this.processService;
    let cancelled = false;

    // Clamp interval between 100ms and 10s to keep watch polling bounded.
    const clampedInterval = Math.max(100, Math.min(interval, 10000));

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: PortWatchEvent) => {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(new TextEncoder().encode(data));
        };

        emit({ type: 'watching', port });

        try {
          while (!cancelled) {
            if (processId) {
              const processResult = await processService.getProcess(processId);
              if (!processResult.success) {
                emit({
                  type: 'error',
                  port,
                  error: 'Process not found'
                });
                break;
              }

              const process = processResult.data;
              if (
                process !== undefined &&
                ['completed', 'failed', 'killed', 'error'].includes(
                  process.status
                )
              ) {
                emit({
                  type: 'process_exited',
                  port,
                  exitCode: process.exitCode
                });
                break;
              }
            }

            const result = await portService.checkPortReady({
              port,
              mode,
              path,
              statusMin,
              statusMax
            });

            if (result.ready) {
              emit({
                type: 'ready',
                port,
                statusCode: result.statusCode
              });
              break;
            }

            await new Promise((resolve) =>
              setTimeout(resolve, clampedInterval)
            );
          }
        } catch (error) {
          emit({
            type: 'error',
            port,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        } finally {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
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
