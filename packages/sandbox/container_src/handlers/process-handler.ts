// Process Handler
import { BaseHandler } from './base-handler';
import type { RequestContext, Logger, StartProcessRequest, ProcessStatus } from '../core/types';
import type { ProcessService } from '../services/process-service';

export class ProcessHandler extends BaseHandler<Request, Response> {
  constructor(
    private processService: ProcessService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api/process/start') {
      return await this.handleStart(request, context);
    } else if (pathname === '/api/process/list') {
      return await this.handleList(request, context);
    } else if (pathname === '/api/process/kill-all') {
      return await this.handleKillAll(request, context);
    } else if (pathname.startsWith('/api/process/')) {
      // Handle dynamic routes for individual processes
      const segments = pathname.split('/');
      if (segments.length >= 4) {
        const processId = segments[3];
        const action = segments[4]; // Optional: logs, stream, etc.

        if (!action && request.method === 'GET') {
          return await this.handleGet(request, context, processId);
        } else if (!action && request.method === 'DELETE') {
          return await this.handleKill(request, context, processId);
        } else if (action === 'logs' && request.method === 'GET') {
          return await this.handleLogs(request, context, processId);
        } else if (action === 'stream' && request.method === 'GET') {
          return await this.handleStream(request, context, processId);
        }
      }
    }

    return this.createErrorResponse('Invalid process endpoint', 404, context);
  }

  private async handleStart(request: Request, context: RequestContext): Promise<Response> {
    const body = this.getValidatedData<StartProcessRequest>(context);
    
    this.logger.info('Starting process', { 
      requestId: context.requestId,
      command: body.command,
      options: body.options
    });

    const result = await this.processService.startProcess(body.command, body.options || {});

    if (result.success) {
      const process = result.data!;
      
      this.logger.info('Process started successfully', {
        requestId: context.requestId,
        processId: process.id,
        pid: process.pid,
        command: process.command,
      });

      return new Response(
        JSON.stringify({
          success: true,
          process: {
            id: process.id,
            pid: process.pid,
            command: process.command,
            status: process.status,
            startTime: process.startTime.toISOString(),
            sessionId: process.sessionId,
          },
          message: 'Process started successfully',
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
      this.logger.error('Process start failed', undefined, {
        requestId: context.requestId,
        command: body.command,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 500, context);
    }
  }

  private async handleList(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Listing processes', { requestId: context.requestId });

    // Extract query parameters for filtering
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    const status = url.searchParams.get('status');

    const filters: { sessionId?: string; status?: ProcessStatus } = {};
    if (sessionId) filters.sessionId = sessionId;
    if (status) filters.status = status as ProcessStatus;

    const result = await this.processService.listProcesses(filters);

    if (result.success) {
      const processes = result.data!.map(process => ({
        id: process.id,
        pid: process.pid,
        command: process.command,
        status: process.status,
        startTime: process.startTime.toISOString(),
        endTime: process.endTime?.toISOString(),
        exitCode: process.exitCode,
        sessionId: process.sessionId,
      }));

      return new Response(
        JSON.stringify({
          success: true,
          count: processes.length,
          processes,
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
      this.logger.error('Process listing failed', undefined, {
        requestId: context.requestId,
        filters,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 500, context);
    }
  }

  private async handleGet(request: Request, context: RequestContext, processId: string): Promise<Response> {
    this.logger.info('Getting process', { 
      requestId: context.requestId,
      processId 
    });

    const result = await this.processService.getProcess(processId);

    if (result.success) {
      const process = result.data!;

      return new Response(
        JSON.stringify({
          success: true,
          process: {
            id: process.id,
            pid: process.pid,
            command: process.command,
            status: process.status,
            startTime: process.startTime.toISOString(),
            endTime: process.endTime?.toISOString(),
            exitCode: process.exitCode,
            sessionId: process.sessionId,
            stdout: process.stdout,
            stderr: process.stderr,
          },
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
      this.logger.error('Process get failed', undefined, {
        requestId: context.requestId,
        processId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 404, context);
    }
  }

  private async handleKill(request: Request, context: RequestContext, processId: string): Promise<Response> {
    this.logger.info('Killing process', { 
      requestId: context.requestId,
      processId 
    });

    const result = await this.processService.killProcess(processId);

    if (result.success) {
      this.logger.info('Process killed successfully', {
        requestId: context.requestId,
        processId,
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Process killed successfully',
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
      this.logger.error('Process kill failed', undefined, {
        requestId: context.requestId,
        processId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 404, context);
    }
  }

  private async handleKillAll(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Killing all processes', { requestId: context.requestId });

    const result = await this.processService.killAllProcesses();

    if (result.success) {
      this.logger.info('All processes killed successfully', {
        requestId: context.requestId,
        count: result.data!,
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: 'All processes killed successfully',
          killedCount: result.data!,
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
      this.logger.error('Kill all processes failed', undefined, {
        requestId: context.requestId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 500, context);
    }
  }

  private async handleLogs(request: Request, context: RequestContext, processId: string): Promise<Response> {
    this.logger.info('Getting process logs', { 
      requestId: context.requestId,
      processId 
    });

    const result = await this.processService.getProcess(processId);

    if (result.success) {
      const process = result.data!;

      return new Response(
        JSON.stringify({
          success: true,
          processId,
          stdout: process.stdout,
          stderr: process.stderr,
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
      this.logger.error('Process logs get failed', undefined, {
        requestId: context.requestId,
        processId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 404, context);
    }
  }

  private async handleStream(request: Request, context: RequestContext, processId: string): Promise<Response> {
    this.logger.info('Streaming process logs', { 
      requestId: context.requestId,
      processId 
    });

    const result = await this.processService.streamProcessLogs(processId);

    if (result.success) {
      // Create SSE stream for process logs
      const processResult = await this.processService.getProcess(processId);
      if (!processResult.success) {
        this.logger.error('Process stream setup failed - process not found', undefined, {
          requestId: context.requestId,
          processId,
          errorCode: processResult.error!.code,
          errorMessage: processResult.error!.message,
        });
        return this.createErrorResponse(processResult.error!, 404, context);
      }

      const process = processResult.data!;

      const stream = new ReadableStream({
        start(controller) {
          // Send initial process info
          const initialData = `data: ${JSON.stringify({
            type: 'process_info',
            processId: process.id,
            command: process.command,
            status: process.status,
            timestamp: new Date().toISOString(),
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(initialData));

          // Send existing logs
          if (process.stdout) {
            const stdoutData = `data: ${JSON.stringify({
              type: 'stdout',
              data: process.stdout,
              processId: process.id,
              timestamp: new Date().toISOString(),
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(stdoutData));
          }

          if (process.stderr) {
            const stderrData = `data: ${JSON.stringify({
              type: 'stderr',
              data: process.stderr,
              processId: process.id,
              timestamp: new Date().toISOString(),
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(stderrData));
          }

          // Set up listeners for new output
          const outputListener = (stream: 'stdout' | 'stderr', data: string) => {
            const eventData = `data: ${JSON.stringify({
              type: stream, // 'stdout' or 'stderr' directly
              data,
              processId: process.id,
              timestamp: new Date().toISOString(),
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(eventData));
          };

          const statusListener = (status: string) => {
            // Close stream when process completes
            if (['completed', 'failed', 'killed', 'error'].includes(status)) {
              const finalData = `data: ${JSON.stringify({
                type: 'exit',
                processId: process.id,
                exitCode: process.exitCode,
                data: `Process ${status} with exit code ${process.exitCode}`,
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
    } else {
      this.logger.error('Process stream failed', undefined, {
        requestId: context.requestId,
        processId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 404, context);
    }
  }
}