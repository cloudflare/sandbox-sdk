import type {
  Logger,
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStartResult,
  ProcessStatus,
  ProcessWaitForExitResult,
  StartProcessRequest,
  WaitForExitRequest
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
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
        } else if (action === 'waitForExit' && request.method === 'POST') {
          return await this.handleWaitForExit(request, context, processId);
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

  private async handleWaitForExit(
    request: Request,
    context: RequestContext,
    processId: string
  ): Promise<Response> {
    const body = await this.parseRequestBody<WaitForExitRequest>(request);

    const result = await this.processService.waitForProcessExit(
      processId,
      body.timeout
    );

    if (result.success) {
      const response: ProcessWaitForExitResult = {
        success: true,
        processId,
        exitCode: result.data.exitCode,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    }

    return this.createErrorResponse(result.error, context);
  }

  private async handleStream(
    request: Request,
    context: RequestContext,
    processId: string
  ): Promise<Response> {
    const processResult = await this.processService.getProcess(processId);
    if (!processResult.success) {
      return this.createErrorResponse(processResult.error, context);
    }

    const process = processResult.data;

    // Hoist listener references so cancel() can access them
    let outputListener:
      | ((stream: 'stdout' | 'stderr', data: string) => void)
      | undefined;
    let statusListener: ((status: string) => void) | undefined;
    const logger = this.logger;

    const removeListeners = () => {
      if (outputListener) process.outputListeners.delete(outputListener);
      if (statusListener) process.statusListeners.delete(statusListener);
    };

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const enqueueSSE = (payload: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        };

        enqueueSSE({
          type: 'process_info',
          processId: process.id,
          command: process.command,
          status: process.status,
          timestamp: new Date().toISOString()
        });

        // Register listeners BEFORE replaying buffered output so no
        // chunk emitted between the snapshot read and registration is
        // lost. Duplicates from replay + listener overlap are harmless;
        // missing data is not.
        outputListener = (stream: 'stdout' | 'stderr', data: string) => {
          try {
            enqueueSSE({
              type: stream,
              data,
              processId: process.id,
              timestamp: new Date().toISOString()
            });
          } catch (err) {
            if (err instanceof TypeError) {
              // Stream was closed or cancelled — remove self to stop further writes
              removeListeners();
            } else {
              logger.error(
                'Unexpected error in output listener',
                err instanceof Error ? err : new Error(String(err))
              );
              controller.error(err);
              removeListeners();
            }
          }
        };

        statusListener = (status: string) => {
          if (['completed', 'failed', 'killed', 'error'].includes(status)) {
            try {
              enqueueSSE({
                type: 'exit',
                processId: process.id,
                exitCode: process.exitCode,
                data: `Process ${status} with exit code ${process.exitCode}`,
                timestamp: new Date().toISOString()
              });
              controller.close();
              removeListeners();
            } catch (err) {
              if (err instanceof TypeError) {
                // Stream already closed — just clean up listeners
                removeListeners();
              } else {
                logger.error(
                  'Unexpected error in status listener',
                  err instanceof Error ? err : new Error(String(err))
                );
                controller.error(err);
                removeListeners();
              }
            }
          }
        };

        process.outputListeners.add(outputListener);
        process.statusListeners.add(statusListener);

        // Replay buffered output collected before the listener was added
        if (process.stdout) {
          enqueueSSE({
            type: 'stdout',
            data: process.stdout,
            processId: process.id,
            timestamp: new Date().toISOString()
          });
        }

        if (process.stderr) {
          enqueueSSE({
            type: 'stderr',
            data: process.stderr,
            processId: process.id,
            timestamp: new Date().toISOString()
          });
        }

        if (
          ['completed', 'failed', 'killed', 'error'].includes(process.status)
        ) {
          enqueueSSE({
            type: 'exit',
            processId: process.id,
            exitCode: process.exitCode,
            data: `Process ${process.status} with exit code ${process.exitCode}`,
            timestamp: new Date().toISOString()
          });
          controller.close();
          removeListeners();
        }
      },
      cancel() {
        removeListeners();
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
