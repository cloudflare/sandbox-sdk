// Interpreter Handler
import type {
  ContextCreateResult,
  ContextDeleteResult,
  ContextListResult,
  InterpreterHealthResult,
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { Logger, RequestContext } from '../core/types';
import type { CreateContextRequest } from '../interpreter-service';
import type { InterpreterService } from '../services/interpreter-service';
import { BaseHandler } from './base-handler';

export class InterpreterHandler extends BaseHandler<Request, Response> {
  constructor(
    private interpreterService: InterpreterService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Health check
    if (pathname === '/api/interpreter/health' && request.method === 'GET') {
      return await this.handleHealth(request, context);
    }

    // Context management
    if (pathname === '/api/contexts' && request.method === 'POST') {
      return await this.handleCreateContext(request, context);
    } else if (pathname === '/api/contexts' && request.method === 'GET') {
      return await this.handleListContexts(request, context);
    } else if (pathname.startsWith('/api/contexts/')) {
      const contextId = pathname.split('/')[3];

      if (request.method === 'DELETE') {
        return await this.handleDeleteContext(request, context, contextId);
      }
    }

    // Code execution
    if (pathname === '/api/execute/code' && request.method === 'POST') {
      return await this.handleExecuteCode(request, context);
    }

    return this.createErrorResponse({
      message: 'Invalid interpreter endpoint',
      code: ErrorCode.UNKNOWN_ERROR,
    }, context);
  }

  private async handleHealth(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Checking interpreter health', { requestId: context.requestId });

    const result = await this.interpreterService.getHealthStatus();

    if (result.success) {
      this.logger.info('Health check successful', {
        requestId: context.requestId
      });

      const response: InterpreterHealthResult = {
        success: true,
        status: result.data.ready ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Health check failed', undefined, {
        requestId: context.requestId,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleCreateContext(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<CreateContextRequest>(request);

    this.logger.info('Creating code context', {
      requestId: context.requestId,
      language: body.language,
      cwd: body.cwd
    });

    const result = await this.interpreterService.createContext(body);

    if (result.success) {
      const contextData = result.data;

      this.logger.info('Context created successfully', {
        requestId: context.requestId,
        contextId: contextData.id,
        language: contextData.language,
      });

      const response: ContextCreateResult = {
        success: true,
        contextId: contextData.id,
        language: contextData.language,
        cwd: contextData.cwd,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Context creation failed', undefined, {
        requestId: context.requestId,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      // Special handling for interpreter not ready - return 503 with Retry-After header
      if (result.error.code === 'INTERPRETER_NOT_READY') {
        return new Response(
          JSON.stringify({
            success: false,
            error: result.error,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(result.error.details?.retryAfter || 5),
              ...context.corsHeaders,
            },
          }
        );
      }

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleListContexts(request: Request, context: RequestContext): Promise<Response> {
    this.logger.info('Listing contexts', { requestId: context.requestId });

    const result = await this.interpreterService.listContexts();

    if (result.success) {
      this.logger.info('Contexts listed successfully', {
        requestId: context.requestId,
        count: result.data.length
      });

      const response: ContextListResult = {
        success: true,
        contexts: result.data.map(ctx => ({
          id: ctx.id,
          language: ctx.language,
          cwd: ctx.cwd,
        })),
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Context listing failed', undefined, {
        requestId: context.requestId,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleDeleteContext(request: Request, context: RequestContext, contextId: string): Promise<Response> {
    this.logger.info('Deleting context', {
      requestId: context.requestId,
      contextId
    });

    const result = await this.interpreterService.deleteContext(contextId);

    if (result.success) {
      this.logger.info('Context deleted successfully', {
        requestId: context.requestId,
        contextId,
      });

      const response: ContextDeleteResult = {
        success: true,
        contextId: contextId,
        timestamp: new Date().toISOString(),
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Context deletion failed', undefined, {
        requestId: context.requestId,
        contextId,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      return this.createErrorResponse(result.error, context);
    }
  }

  private async handleExecuteCode(request: Request, context: RequestContext): Promise<Response> {
    const body = await this.parseRequestBody<{
      context_id: string;
      code: string;
      language?: string;
    }>(request);

    this.logger.info('Executing code', {
      requestId: context.requestId,
      contextId: body.context_id,
      language: body.language,
      codeLength: body.code.length
    });

    // The service returns a Response directly for streaming
    // No need to wrap with ServiceResult as it's already handled
    const response = await this.interpreterService.executeCode(
      body.context_id,
      body.code,
      body.language
    );

    // If it's an error response, log it
    if (!response.ok) {
      this.logger.error('Code execution failed', undefined, {
        requestId: context.requestId,
        contextId: body.context_id,
        status: response.status,
      });
    } else {
      this.logger.info('Code execution started', {
        requestId: context.requestId,
        contextId: body.context_id,
      });
    }

    return response;
  }
}
