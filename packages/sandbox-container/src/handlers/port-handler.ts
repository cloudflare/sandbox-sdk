// Port Handler
import type {
  ExposePortRequest,
  Logger,
  PortCloseResult,
  PortExposeResult,
  PortListResult,
  PortWatchEvent,
  PortWatchRequest
} from '@repo/shared';
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

    if (pathname === '/api/expose-port') {
      return await this.handleExpose(request, context);
    } else if (pathname === '/api/port-watch') {
      return await this.handlePortWatch(request, context);
    } else if (pathname === '/api/exposed-ports') {
      return await this.handleList(request, context);
    } else if (pathname.startsWith('/api/exposed-ports/')) {
      // Handle dynamic routes for individual ports
      const segments = pathname.split('/');
      if (segments.length >= 4) {
        const portStr = segments[3];
        const port = parseInt(portStr, 10);

        if (!Number.isNaN(port) && request.method === 'DELETE') {
          return await this.handleUnexpose(request, context, port);
        }
      }
    } else if (pathname.startsWith('/proxy/')) {
      return await this.handleProxy(request, context);
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

    // Clamp interval between 100ms and 10s to prevent abuse
    const clampedInterval = Math.max(100, Math.min(interval, 10000));

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: PortWatchEvent) => {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(new TextEncoder().encode(data));
        };

        // Send initial event
        emit({ type: 'watching', port });

        try {
          // Polling loop
          while (!cancelled) {
            // Check process status if processId provided
            if (processId) {
              const processResult = await processService.getProcess(processId);
              if (!processResult.success) {
                emit({ type: 'error', port, error: 'Process not found' });
                return;
              }
              const proc = processResult.data;
              if (
                ['completed', 'failed', 'killed', 'error'].includes(proc.status)
              ) {
                emit({
                  type: 'process_exited',
                  port,
                  exitCode: proc.exitCode ?? undefined
                });
                return;
              }
            }

            // Check port readiness
            const result = await portService.checkPortReady({
              port,
              mode,
              path,
              statusMin,
              statusMax
            });

            if (result.ready) {
              emit({ type: 'ready', port, statusCode: result.statusCode });
              return;
            }

            // Wait before next check
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

  private async handleExpose(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<ExposePortRequest>(request);

    const result = await this.portService.exposePort(body.port, body.name);

    if (result.success) {
      const portInfo = result.data!;

      const response: PortExposeResult = {
        success: true,
        port: portInfo.port,
        url: `http://localhost:${portInfo.port}`, // Generate URL from port
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleUnexpose(
    request: Request,
    context: RequestContext,
    port: number
  ): Promise<Response> {
    const result = await this.portService.unexposePort(port);

    if (result.success) {
      const response: PortCloseResult = {
        success: true,
        port,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleList(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const result = await this.portService.getExposedPorts();

    if (result.success) {
      const ports = result.data!.map((portInfo) => ({
        port: portInfo.port,
        url: `http://localhost:${portInfo.port}`,
        status: portInfo.status
      }));

      const response: PortListResult = {
        success: true,
        ports,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleProxy(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    try {
      // Extract port from URL path: /proxy/{port}/...
      const url = new URL(request.url);
      const pathSegments = url.pathname.split('/');

      if (pathSegments.length < 3) {
        return this.createErrorResponse(
          {
            message: 'Invalid proxy URL format',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
      }

      const portStr = pathSegments[2];
      const port = parseInt(portStr, 10);

      if (Number.isNaN(port)) {
        return this.createErrorResponse(
          {
            message: 'Invalid port number in proxy URL',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
      }

      // Use the port service to proxy the request
      const response = await this.portService.proxyRequest(port, request);

      return response;
    } catch (error) {
      this.logger.error(
        'Proxy request failed',
        error instanceof Error ? error : undefined,
        {
          requestId: context.requestId
        }
      );

      return this.createErrorResponse(
        {
          message:
            error instanceof Error ? error.message : 'Proxy request failed',
          code: ErrorCode.UNKNOWN_ERROR
        },
        context
      );
    }
  }
}
