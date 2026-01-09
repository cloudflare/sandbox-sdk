import type {
  CreatePtyOptions,
  Logger,
  PtyCreateResult,
  PtyGetResult,
  PtyInputRequest,
  PtyInputResult,
  PtyKillResult,
  PtyListResult,
  PtyResizeRequest,
  PtyResizeResult
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
import type { PtyManager } from '../managers/pty-manager';
import { BaseHandler } from './base-handler';

export class PtyHandler extends BaseHandler<Request, Response> {
  constructor(
    private ptyManager: PtyManager,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // POST /api/pty - Create new PTY
    if (pathname === '/api/pty' && request.method === 'POST') {
      return this.handleCreate(request, context);
    }

    // GET /api/pty - List all PTYs
    if (pathname === '/api/pty' && request.method === 'GET') {
      return this.handleList(request, context);
    }

    // Routes with PTY ID
    if (pathname.startsWith('/api/pty/')) {
      const segments = pathname.split('/');
      const ptyId = segments[3];
      const action = segments[4];

      if (!ptyId) {
        return this.createErrorResponse(
          { message: 'PTY ID required', code: ErrorCode.VALIDATION_FAILED },
          context
        );
      }

      // GET /api/pty/:id - Get PTY info
      if (!action && request.method === 'GET') {
        return this.handleGet(request, context, ptyId);
      }

      // DELETE /api/pty/:id - Kill PTY
      if (!action && request.method === 'DELETE') {
        return this.handleKill(request, context, ptyId);
      }

      // POST /api/pty/:id/input - Send input to PTY
      if (action === 'input' && request.method === 'POST') {
        return this.handleInput(request, context, ptyId);
      }

      // POST /api/pty/:id/resize - Resize PTY
      if (action === 'resize' && request.method === 'POST') {
        return this.handleResize(request, context, ptyId);
      }

      // GET /api/pty/:id/stream - SSE output stream
      if (action === 'stream' && request.method === 'GET') {
        return this.handleStream(request, context, ptyId);
      }
    }

    // POST /api/pty/attach/:sessionId - Attach PTY to existing session
    if (pathname.startsWith('/api/pty/attach/') && request.method === 'POST') {
      const sessionId = pathname.split('/')[4];
      if (!sessionId) {
        return this.createErrorResponse(
          { message: 'Session ID required', code: ErrorCode.VALIDATION_FAILED },
          context
        );
      }
      return this.handleAttach(request, context, sessionId);
    }

    return this.createErrorResponse(
      { message: 'Invalid PTY endpoint', code: ErrorCode.UNKNOWN_ERROR },
      context
    );
  }

  private async handleCreate(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<CreatePtyOptions>(request);
    const ptySession = this.ptyManager.create(body);

    const response: PtyCreateResult = {
      success: true,
      pty: {
        id: ptySession.id,
        cols: ptySession.cols,
        rows: ptySession.rows,
        command: ptySession.command,
        cwd: ptySession.cwd,
        createdAt: ptySession.createdAt.toISOString(),
        state: ptySession.state,
        exitCode: ptySession.exitCode
      },
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleList(
    _request: Request,
    context: RequestContext
  ): Promise<Response> {
    const ptys = this.ptyManager.list();

    const response: PtyListResult = {
      success: true,
      ptys,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleGet(
    _request: Request,
    context: RequestContext,
    ptyId: string
  ): Promise<Response> {
    const ptySession = this.ptyManager.get(ptyId);

    if (!ptySession) {
      return this.createErrorResponse(
        { message: 'PTY not found', code: ErrorCode.PTY_NOT_FOUND },
        context
      );
    }

    const response: PtyGetResult = {
      success: true,
      pty: {
        id: ptySession.id,
        cols: ptySession.cols,
        rows: ptySession.rows,
        command: ptySession.command,
        cwd: ptySession.cwd,
        createdAt: ptySession.createdAt.toISOString(),
        state: ptySession.state,
        exitCode: ptySession.exitCode
      },
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleKill(
    request: Request,
    context: RequestContext,
    ptyId: string
  ): Promise<Response> {
    const session = this.ptyManager.get(ptyId);

    if (!session) {
      return this.createErrorResponse(
        { message: 'PTY not found', code: ErrorCode.PTY_NOT_FOUND },
        context
      );
    }

    // Body is optional for DELETE - only parse if content exists
    let signal: string | undefined;
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 0) {
      const body = await this.parseRequestBody<{ signal?: string }>(request);
      signal = body.signal;
    }

    const result = this.ptyManager.kill(ptyId, signal);

    if (!result.success) {
      return this.createErrorResponse(
        {
          message: result.error ?? 'PTY kill failed',
          code: ErrorCode.PTY_OPERATION_ERROR
        },
        context
      );
    }

    const response: PtyKillResult = {
      success: true,
      ptyId,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleInput(
    request: Request,
    context: RequestContext,
    ptyId: string
  ): Promise<Response> {
    const session = this.ptyManager.get(ptyId);

    if (!session) {
      return this.createErrorResponse(
        { message: 'PTY not found', code: ErrorCode.PTY_NOT_FOUND },
        context
      );
    }

    const body = await this.parseRequestBody<PtyInputRequest>(request);

    if (!body.data) {
      return this.createErrorResponse(
        { message: 'Input data required', code: ErrorCode.VALIDATION_FAILED },
        context
      );
    }

    const result = this.ptyManager.write(ptyId, body.data);

    if (!result.success) {
      return this.createErrorResponse(
        {
          message: result.error ?? 'PTY input failed',
          code: ErrorCode.PTY_OPERATION_ERROR
        },
        context
      );
    }

    const response: PtyInputResult = {
      success: true,
      ptyId,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleResize(
    request: Request,
    context: RequestContext,
    ptyId: string
  ): Promise<Response> {
    const session = this.ptyManager.get(ptyId);

    if (!session) {
      return this.createErrorResponse(
        { message: 'PTY not found', code: ErrorCode.PTY_NOT_FOUND },
        context
      );
    }

    const body = await this.parseRequestBody<PtyResizeRequest>(request);

    if (body.cols === undefined || body.rows === undefined) {
      return this.createErrorResponse(
        {
          message: 'Both cols and rows are required',
          code: ErrorCode.VALIDATION_FAILED
        },
        context
      );
    }

    const result = this.ptyManager.resize(ptyId, body.cols, body.rows);

    if (!result.success) {
      return this.createErrorResponse(
        {
          message: result.error ?? 'PTY resize failed',
          code: ErrorCode.PTY_OPERATION_ERROR
        },
        context
      );
    }

    const response: PtyResizeResult = {
      success: true,
      ptyId,
      cols: body.cols,
      rows: body.rows,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleAttach(
    request: Request,
    context: RequestContext,
    sessionId: string
  ): Promise<Response> {
    // Check if session already has a PTY attached
    const existingPtys = this.ptyManager.list();
    const existingPty = existingPtys.find((p) => p.sessionId === sessionId);

    if (existingPty && existingPty.state === 'running') {
      return this.createErrorResponse(
        {
          message: `Session already has active PTY: ${existingPty.id}`,
          code: ErrorCode.PTY_ALREADY_ATTACHED
        },
        context
      );
    }

    // Create a PTY attached to the session
    const body = await this.parseRequestBody<CreatePtyOptions>(request);
    const ptySession = this.ptyManager.create({
      ...body,
      sessionId
    });

    const response: PtyCreateResult = {
      success: true,
      pty: {
        id: ptySession.id,
        cols: ptySession.cols,
        rows: ptySession.rows,
        command: ptySession.command,
        cwd: ptySession.cwd,
        createdAt: ptySession.createdAt.toISOString(),
        state: ptySession.state,
        exitCode: ptySession.exitCode,
        sessionId
      },
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleStream(
    _request: Request,
    context: RequestContext,
    ptyId: string
  ): Promise<Response> {
    const session = this.ptyManager.get(ptyId);

    if (!session) {
      return this.createErrorResponse(
        { message: 'PTY not found', code: ErrorCode.PTY_NOT_FOUND },
        context
      );
    }

    // Track cleanup functions for proper unsubscription
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;

    // Capture logger for use in stream callbacks
    const logger = this.logger;

    const stream = new ReadableStream({
      start: (controller) => {
        const encoder = new TextEncoder();

        // Send initial info
        const info = `data: ${JSON.stringify({
          type: 'pty_info',
          ptyId: session.id,
          cols: session.cols,
          rows: session.rows,
          timestamp: new Date().toISOString()
        })}\n\n`;
        controller.enqueue(encoder.encode(info));

        // Listen for data
        unsubData = this.ptyManager.onData(ptyId, (data) => {
          try {
            const event = `data: ${JSON.stringify({
              type: 'pty_data',
              data,
              timestamp: new Date().toISOString()
            })}\n\n`;
            controller.enqueue(encoder.encode(event));
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            // TypeError with 'closed' or 'errored' indicates client disconnect (expected)
            // Other errors may indicate infrastructure issues
            const isExpectedDisconnect =
              error instanceof TypeError &&
              (errorMessage.includes('closed') ||
                errorMessage.includes('errored'));
            if (isExpectedDisconnect) {
              logger.debug('SSE stream enqueue skipped (client disconnected)', {
                ptyId
              });
            } else {
              logger.error(
                'SSE stream enqueue failed unexpectedly',
                error instanceof Error ? error : new Error(errorMessage),
                { ptyId }
              );
            }
          }
        });

        // Listen for exit
        unsubExit = this.ptyManager.onExit(ptyId, (exitCode) => {
          try {
            const event = `data: ${JSON.stringify({
              type: 'pty_exit',
              exitCode,
              timestamp: new Date().toISOString()
            })}\n\n`;
            controller.enqueue(encoder.encode(event));
            controller.close();
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            // TypeError with 'closed' or 'errored' indicates client disconnect (expected)
            // Other errors may indicate infrastructure issues
            const isExpectedDisconnect =
              error instanceof TypeError &&
              (errorMessage.includes('closed') ||
                errorMessage.includes('errored'));
            if (isExpectedDisconnect) {
              logger.debug('SSE stream close skipped (client disconnected)', {
                ptyId,
                exitCode
              });
            } else {
              logger.error(
                'SSE stream close failed unexpectedly',
                error instanceof Error ? error : new Error(errorMessage),
                { ptyId, exitCode }
              );
            }
          }
        });
      },
      cancel: () => {
        // Clean up listeners when stream is cancelled
        unsubData?.();
        unsubExit?.();
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
