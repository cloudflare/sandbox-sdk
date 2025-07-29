// Session Handler
import { BaseHandler } from './base-handler';
import type { RequestContext, Logger } from '../core/types';
import type { SessionService } from '../services/session-service';

export class SessionHandler extends BaseHandler<Request, Response> {
  constructor(
    private sessionService: SessionService,
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
    this.logger.info('Creating new session', { requestId: context.requestId });

    const result = await this.sessionService.createSession();
    
    if (result.success) {
      this.logger.info('Session created successfully', { 
        requestId: context.requestId, 
        sessionId: result.data!.sessionId 
      });
      
      return new Response(
        JSON.stringify({
          message: 'Session created successfully',
          sessionId: result.data!.sessionId,
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
      this.logger.error('Session creation failed', undefined, {
        requestId: context.requestId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 500, context);
    }
  }

  private async handleList(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Listing sessions', { requestId: context.requestId });

    const result = await this.sessionService.listSessions();
    
    if (result.success) {
      const sessionList = result.data!.map(session => ({
        sessionId: session.sessionId,
        createdAt: session.createdAt.toISOString(),
        hasActiveProcess: !!session.activeProcess,
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
    } else {
      this.logger.error('Session listing failed', undefined, {
        requestId: context.requestId,
        errorCode: result.error!.code,
        errorMessage: result.error!.message,
      });
      return this.createErrorResponse(result.error!, 500, context);
    }
  }
}