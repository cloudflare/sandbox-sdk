// Session Handler

import type { Logger, RequestContext } from '../core/types';
import type { SessionManager } from '../isolation';
import type { CreateSessionRequest } from '../validation/schemas';
import { CreateSessionRequestSchema } from '../validation/schemas';
import { BaseHandler } from './base-handler';

export class SessionHandler extends BaseHandler<Request, Response> {
  constructor(
    private sessionManager: SessionManager,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/session/create':
        return await this.handleCreate(request, context);
      case '/api/session/list':
        return await this.handleList(request, context);
      default:
        return this.createErrorResponse('Invalid session endpoint', 404, context);
    }
  }

  private async handleCreate(request: Request, context: RequestContext): Promise<Response> {
    try {
      // Parse and validate request body
      const body = await request.json() as CreateSessionRequest;
      const validationResult = CreateSessionRequestSchema.safeParse(body);
      
      if (!validationResult.success) {
        this.logger.error('Session creation validation failed', undefined, {
          requestId: context.requestId,
          errors: validationResult.error.issues,
        });
        return this.createErrorResponse(
          { message: 'Invalid session creation request', code: 'VALIDATION_ERROR' },
          400,
          context
        );
      }

      const { id, env, cwd, isolation } = validationResult.data;
      this.logger.info('Creating new session', { 
        requestId: context.requestId, 
        sessionId: id,
        cwd: cwd || '/workspace',
        isolation: isolation !== false
      });

      // Create session directly using SessionManager (following main branch pattern)
      await this.sessionManager.createSession({
        id,
        cwd: cwd || '/workspace',
        isolation: isolation !== false, // Default to true
      });
      
      this.logger.info('Session created successfully', { 
        requestId: context.requestId, 
        sessionId: id 
      });
      
      return new Response(
        JSON.stringify({
          success: true,
          id,
          message: `Session '${id}' created with${isolation !== false ? '' : 'out'} isolation`,
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
    } catch (error) {
      this.logger.error('Session creation failed', undefined, {
        requestId: context.requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.createErrorResponse(
        { message: 'Failed to create session', code: 'SESSION_CREATE_ERROR' },
        500,
        context
      );
    }
  }

  private async handleList(request: Request, context: RequestContext): Promise<Response> {
    try {
      this.logger.info('Listing sessions', { requestId: context.requestId });

      const sessionIds = this.sessionManager.listSessions();
      
      const sessionList = sessionIds.map((sessionId: string) => ({
        id: sessionId,
        sessionId: sessionId, // Keep both for compatibility
        createdAt: new Date().toISOString(),
        hasActiveProcess: false,
      }));

      return new Response(
        JSON.stringify({
          count: sessionList.length,
          sessions: sessionList,
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
    } catch (error) {
      this.logger.error('Session listing failed', undefined, {
        requestId: context.requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.createErrorResponse(
        { message: 'Failed to list sessions', code: 'SESSION_LIST_ERROR' },
        500,
        context
      );
    }
  }
}