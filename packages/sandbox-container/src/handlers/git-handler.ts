// Git Handler
import type { GitCheckoutResult, Logger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
import type { GitService } from '../services/git-service';
import type { RequestValidator } from '../validation/request-validator';
import { BaseHandler } from './base-handler';

export class GitHandler extends BaseHandler<Request, Response> {
  constructor(
    private gitService: GitService,
    private validator: RequestValidator,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/git/checkout':
        return await this.handleCheckout(request, context);
      default:
        return this.createErrorResponse(
          {
            message: 'Invalid git endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  private async handleCheckout(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const rawBody = await this.parseRequestBody<unknown>(request);

    // Validate request body using Zod schema
    const validation = this.validator.validateGitRequest(rawBody);
    if (!validation.isValid) {
      return this.createErrorResponse(
        {
          message: `Invalid request: ${validation.errors.map((e) => e.message).join(', ')}`,
          code: ErrorCode.VALIDATION_FAILED,
          details: { errors: validation.errors }
        },
        context
      );
    }

    const body = validation.data;
    const sessionId = body.sessionId || context.sessionId;

    const result = await this.gitService.cloneRepository(body.repoUrl, {
      branch: body.branch,
      targetDir: body.targetDir,
      sessionId,
      depth: body.depth
    });

    if (result.success) {
      const response: GitCheckoutResult = {
        success: true,
        repoUrl: body.repoUrl,
        branch: result.data.branch,
        targetDir: result.data.path,
        timestamp: new Date().toISOString()
      };

      return this.createTypedResponse(response, context);
    } else {
      this.logger.error('Repository clone failed', undefined, {
        requestId: context.requestId,
        repoUrl: body.repoUrl,
        errorCode: result.error.code,
        errorMessage: result.error.message
      });

      return this.createErrorResponse(result.error, context);
    }
  }
}
