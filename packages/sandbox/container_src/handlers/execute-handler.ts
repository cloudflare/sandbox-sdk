// Execute Handler
import { BaseHandler } from './base-handler';
import type { RequestContext, Logger, ExecuteRequest } from '../core/types';
import type { ProcessService } from '../services/process-service';
import type { SessionService } from '../services/session-service';

export class ExecuteHandler extends BaseHandler<Request, Response> {
  constructor(
    private processService: ProcessService,
    private sessionService: SessionService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      switch (pathname) {
        case '/api/execute':
          return await this.handleExecute(request, context);
        case '/api/execute/stream':
          return await this.handleStreamingExecute(request, context);
        default:
          return this.createErrorResponse('Invalid execute endpoint', 404, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleExecute(request: Request, context: RequestContext): Promise<Response> {
    try {
      const body = await this.parseRequestBody<ExecuteRequest>(request);
      
      this.logger.info('Executing command', { 
        requestId: context.requestId,
        command: body.command,
        sessionId: body.sessionId,
        background: body.background
      });

      // If this is a background process, start it as a process
      if (body.background) {
        const processResult = await this.processService.startProcess(body.command, {
          sessionId: body.sessionId,
        });

        if (processResult.success) {
          return new Response(
            JSON.stringify({
              success: true,
              processId: processResult.data!.id,
              message: 'Background process started successfully',
              timestamp: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                ...context.corsHeaders,
              },
            }
          );
        } else {
          return this.createErrorResponse(processResult.error!, 500, context);
        }
      }

      // For non-background commands, execute and return result
      const result = await this.processService.executeCommand(body.command, {
        sessionId: body.sessionId,
      });

      if (result.success) {
        const commandResult = result.data!;
        
        this.logger.info('Command executed successfully', {
          requestId: context.requestId,
          command: body.command,
          exitCode: commandResult.exitCode,
          success: commandResult.success,
        });

        return new Response(
          JSON.stringify({
            success: commandResult.success,
            exitCode: commandResult.exitCode,
            stdout: commandResult.stdout,
            stderr: commandResult.stderr,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...context.corsHeaders,
            },
          }
        );
      } else {
        return this.createErrorResponse(result.error!, 500, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleStreamingExecute(request: Request, context: RequestContext): Promise<Response> {
    try {
      const body = await this.parseRequestBody<ExecuteRequest>(request);
      
      this.logger.info('Starting streaming command execution', { 
        requestId: context.requestId,
        command: body.command,
        sessionId: body.sessionId
      });

      // Start the process for streaming
      const processResult = await this.processService.startProcess(body.command, {
        sessionId: body.sessionId,
      });

      if (!processResult.success) {
        return this.createErrorResponse(processResult.error!, 500, context);
      }

      const process = processResult.data!;

      // Create SSE stream
      const stream = new ReadableStream({
        start(controller) {
          // Send initial process info
          const initialData = `data: ${JSON.stringify({
            type: 'process_started',
            processId: process.id,
            command: process.command,
            timestamp: new Date().toISOString(),
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(initialData));

          // Set up output listeners
          const outputListener = (stream: 'stdout' | 'stderr', data: string) => {
            const eventData = `data: ${JSON.stringify({
              type: 'output',
              stream,
              data,
              timestamp: new Date().toISOString(),
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(eventData));
          };

          const statusListener = (status: string) => {
            const eventData = `data: ${JSON.stringify({
              type: 'status_change',
              status,
              timestamp: new Date().toISOString(),
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(eventData));

            // Close stream when process completes
            if (['completed', 'failed', 'killed', 'error'].includes(status)) {
              const finalData = `data: ${JSON.stringify({
                type: 'process_ended',
                status,
                exitCode: process.exitCode,
                timestamp: new Date().toISOString(),
              })}\n\n`;
              controller.enqueue(new TextEncoder().encode(finalData));
              controller.close();
            }
          };

          // Add listeners
          process.outputListeners.add(outputListener);
          process.statusListeners.add(statusListener);

          // Cleanup when stream is cancelled
          return () => {
            process.outputListeners.delete(outputListener);
            process.statusListeners.delete(statusListener);
          };
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...context.corsHeaders,
        },
      });
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }
}