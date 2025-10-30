import type {
  Logger,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStartResult
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type {
  ProcessStatus,
  RequestContext,
  StartProcessRequest
} from '../core/types';
import type { ProcessService } from '../services/process-service';
import { BaseHandler } from './base-handler';

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

    return this.createErrorResponse(
      {
        message: 'Invalid process endpoint',
        code: ErrorCode.UNKNOWN_ERROR
      },
      context
    );
  }

  private async handleStart(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<StartProcessRequest>(request);

    // Extract command and pass remaining fields as options (flat structure)
    const { command, ...options } = body;

    const result = await this.processService.startProcess(command, options);

    if (result.success) {
      const process = result.data;

      const response: ProcessStartResult = {
        success: true,
        processId: process.id,
        pid: process.pid,
        command: process.command,
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
    // Extract query parameters for filtering
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    // Processes are sandbox-scoped, not session-scoped
    // All sessions in a sandbox can see all processes (like terminals in Linux)
    const filters: { status?: ProcessStatus } = {};
    if (status) filters.status = status as ProcessStatus;

    const result = await this.processService.listProcesses(filters);

    if (result.success) {
      const response: ProcessListResult = {
        success: true,
        processes: result.data.map((process) => ({
          id: process.id,
          pid: process.pid,
          command: process.command,
          status: process.status,
          startTime: process.startTime.toISOString(),
          exitCode: process.exitCode
        })),
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleGet(
    request: Request,
    context: RequestContext,
    processId: string
  ): Promise<Response> {
    const result = await this.processService.getProcess(processId);

    if (result.success) {
      const process = result.data;

      const response: ProcessInfoResult = {
        success: true,
        process: {
          id: process.id,
          pid: process.pid,
          command: process.command,
          status: process.status,
          startTime: process.startTime.toISOString(),
          endTime: process.endTime?.toISOString(),
          exitCode: process.exitCode
        },
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleKill(
    request: Request,
    context: RequestContext,
    processId: string
  ): Promise<Response> {
    const result = await this.processService.killProcess(processId);

    if (result.success) {
      const response: ProcessKillResult = {
        success: true,
        processId,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleKillAll(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const result = await this.processService.killAllProcesses();

    if (result.success) {
      const response: ProcessCleanupResult = {
        success: true,
        cleanedCount: result.data,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleLogs(
    request: Request,
    context: RequestContext,
    processId: string
  ): Promise<Response> {
    const result = await this.processService.getProcess(processId);

    if (result.success) {
      const process = result.data;

      const response: ProcessLogsResult = {
        success: true,
        processId,
        stdout: process.stdout,
        stderr: process.stderr,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleStream(
    request: Request,
    context: RequestContext,
    processId: string
  ): Promise<Response> {
    const result = await this.processService.streamProcessLogs(processId);

    if (result.success) {
      // Create SSE stream for process logs
      const processResult = await this.processService.getProcess(processId);
      if (!processResult.success) {
        return this.createErrorResponse(processResult.error, context);
      }

      const process = processResult.data;

      const stream = new ReadableStream({
        start(controller) {
          // Send initial process info
          const initialData = `data: ${JSON.stringify({
            type: 'process_info',
            processId: process.id,
            command: process.command,
            status: process.status,
            timestamp: new Date().toISOString()
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(initialData));

          // Send existing logs
          if (process.stdout) {
            const stdoutData = `data: ${JSON.stringify({
              type: 'stdout',
              data: process.stdout,
              processId: process.id,
              timestamp: new Date().toISOString()
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(stdoutData));
          }

          if (process.stderr) {
            const stderrData = `data: ${JSON.stringify({
              type: 'stderr',
              data: process.stderr,
              processId: process.id,
              timestamp: new Date().toISOString()
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(stderrData));
          }

          // Set up listeners for new output
          const outputListener = (
            stream: 'stdout' | 'stderr',
            data: string
          ) => {
            const eventData = `data: ${JSON.stringify({
              type: stream, // 'stdout' or 'stderr' directly
              data,
              processId: process.id,
              timestamp: new Date().toISOString()
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
                timestamp: new Date().toISOString()
              })}\n\n`;
              controller.enqueue(new TextEncoder().encode(finalData));
              controller.close();
            }
          };

          // Add listeners
          process.outputListeners.add(outputListener);
          process.statusListeners.add(statusListener);

          // If process already completed, send exit event immediately
          if (
            ['completed', 'failed', 'killed', 'error'].includes(process.status)
          ) {
            const finalData = `data: ${JSON.stringify({
              type: 'exit',
              processId: process.id,
              exitCode: process.exitCode,
              data: `Process ${process.status} with exit code ${process.exitCode}`,
              timestamp: new Date().toISOString()
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(finalData));
            controller.close();
          }

          // Cleanup when stream is cancelled
          return () => {
            process.outputListeners.delete(outputListener);
            process.statusListeners.delete(statusListener);
          };
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
    } else {
      return this.createErrorResponse(result.error, context);
    }
  }
}
