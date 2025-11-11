// Execute Handler
import type { ExecResult, Logger, ProcessStartResult } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { ExecuteRequest, RequestContext } from '../core/types';
import type { ProcessService } from '../services/process-service';
import { BaseHandler } from './base-handler';

export class ExecuteHandler extends BaseHandler<Request, Response> {
  constructor(
    private processService: ProcessService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/execute':
        return await this.handleExecute(request, context);
      case '/api/execute/stream':
        return await this.handleStreamingExecute(request, context);
      default:
        return this.createErrorResponse(
          {
            message: 'Invalid execute endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  private async handleExecute(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    // Parse request body directly
    const body = await this.parseRequestBody<ExecuteRequest>(request);
    const sessionId = body.sessionId || context.sessionId;

    // If this is a background process, start it as a process
    if (body.background) {
      const processResult = await this.processService.startProcess(
        body.command,
        {
          sessionId,
          timeoutMs: body.timeoutMs,
          env: body.env,
          cwd: body.cwd
        }
      );

      if (!processResult.success) {
        return this.createErrorResponse(processResult.error, context);
      }

      const processData = processResult.data;

      const response: ProcessStartResult = {
        success: true,
        processId: processData.id,
        pid: processData.pid,
        command: body.command,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    }

    // For non-background commands, execute and return result
    const result = await this.processService.executeCommand(body.command, {
      sessionId,
      timeoutMs: body.timeoutMs,
      env: body.env,
      cwd: body.cwd
    });

    if (!result.success) {
      return this.createErrorResponse(result.error, context);
    }

    const commandResult = result.data;

    const response: ExecResult = {
      success: commandResult.success,
      exitCode: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      command: body.command,
      duration: 0, // Duration not tracked at service level yet
      timestamp: new Date().toISOString(),
      sessionId: sessionId
    };

    return this.createTypedResponse(response, context);
  }

  private async handleStreamingExecute(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    // Parse request body directly
    const body = await this.parseRequestBody<ExecuteRequest>(request);
    const sessionId = body.sessionId || context.sessionId;

    // Start the process for streaming
    const processResult = await this.processService.startProcess(body.command, {
      sessionId,
      env: body.env,
      cwd: body.cwd
    });

    if (!processResult.success) {
      return this.createErrorResponse(processResult.error, context);
    }

    const process = processResult.data;

    // Create SSE stream
    const stream = new ReadableStream({
      start(controller) {
        // Send initial process info
        const initialData = `data: ${JSON.stringify({
          type: 'start',
          command: process.command,
          timestamp: new Date().toISOString()
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(initialData));

        // Send any already-buffered stdout/stderr (for fast-completing processes)
        if (process.stdout) {
          const stdoutData = `data: ${JSON.stringify({
            type: 'stdout',
            data: process.stdout,
            timestamp: new Date().toISOString()
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(stdoutData));
        }

        if (process.stderr) {
          const stderrData = `data: ${JSON.stringify({
            type: 'stderr',
            data: process.stderr,
            timestamp: new Date().toISOString()
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(stderrData));
        }

        // Set up output listeners for future output
        const outputListener = (stream: 'stdout' | 'stderr', data: string) => {
          const eventData = `data: ${JSON.stringify({
            type: stream, // 'stdout' or 'stderr' directly
            data,
            timestamp: new Date().toISOString()
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(eventData));
        };

        const statusListener = (status: string) => {
          // Close stream when process completes
          if (['completed', 'failed', 'killed', 'error'].includes(status)) {
            const finalData = `data: ${JSON.stringify({
              type: 'complete',
              exitCode: process.exitCode,
              timestamp: new Date().toISOString()
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(finalData));
            controller.close();
          }
        };

        // Add listeners
        process.outputListeners.add(outputListener);
        process.statusListeners.add(statusListener);

        // If process already completed, send complete event immediately
        if (
          ['completed', 'failed', 'killed', 'error'].includes(process.status)
        ) {
          const finalData = `data: ${JSON.stringify({
            type: 'complete',
            exitCode: process.exitCode,
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
  }
}
