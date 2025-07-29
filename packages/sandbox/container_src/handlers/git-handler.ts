// Git Handler
import { BaseHandler } from './base-handler';
import type { RequestContext, Logger, GitCheckoutRequest } from '../core/types';
import type { GitService } from '../services/git-service';

export class GitHandler extends BaseHandler<Request, Response> {
  constructor(
    private gitService: GitService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      switch (pathname) {
        case '/api/git/checkout':
          return await this.handleCheckout(request, context);
        default:
          return this.createErrorResponse('Invalid git endpoint', 404, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }

  private async handleCheckout(request: Request, context: RequestContext): Promise<Response> {
    try {
      const body = await this.parseRequestBody<GitCheckoutRequest>(request);
      
      this.logger.info('Cloning git repository', { 
        requestId: context.requestId,
        repoUrl: body.repoUrl,
        branch: body.branch,
        targetDir: body.targetDir
      });

      const result = await this.gitService.cloneRepository(body.repoUrl, {
        branch: body.branch,
        targetDir: body.targetDir,
        sessionId: body.sessionId,
      });

      if (result.success) {
        const gitResult = result.data!;
        
        this.logger.info('Repository cloned successfully', {
          requestId: context.requestId,
          repoUrl: body.repoUrl,
          targetDirectory: gitResult.targetDirectory,
          branch: body.branch,
        });

        return new Response(
          JSON.stringify({
            success: true,
            message: gitResult.message,
            repoUrl: body.repoUrl,
            branch: body.branch,
            targetDirectory: gitResult.targetDirectory,
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
        return this.createErrorResponse(result.error!, 400, context);
      }
    } catch (error) {
      return this.createErrorResponse(error instanceof Error ? error : 'Unknown error', 500, context);
    }
  }
}