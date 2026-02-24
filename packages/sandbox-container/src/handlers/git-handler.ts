// Git Handler
import type {
  GitAddRequest,
  GitBranchListResult,
  GitCheckoutBranchRequest,
  GitCheckoutRequest,
  GitCheckoutResult,
  GitCommitRequest,
  GitCreateBranchRequest,
  GitDeleteBranchRequest,
  GitOperationResult,
  GitRepoPathRequest,
  GitResetRequest,
  GitRestoreRequest,
  GitStatusResult,
  Logger
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
import type { GitService } from '../services/git-service';
import { BaseHandler } from './base-handler';

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

    switch (pathname) {
      case '/api/git/checkout':
        return await this.handleCheckout(request, context);
      case '/api/git/status':
        return await this.handleStatus(request, context);
      case '/api/git/branches':
        return await this.handleListBranches(request, context);
      case '/api/git/checkout-branch':
        return await this.handleCheckoutBranch(request, context);
      case '/api/git/create-branch':
        return await this.handleCreateBranch(request, context);
      case '/api/git/delete-branch':
        return await this.handleDeleteBranch(request, context);
      case '/api/git/add':
        return await this.handleAdd(request, context);
      case '/api/git/commit':
        return await this.handleCommit(request, context);
      case '/api/git/reset':
        return await this.handleReset(request, context);
      case '/api/git/restore':
        return await this.handleRestore(request, context);
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
    const body = await this.parseRequestBody<GitCheckoutRequest>(request);
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
    }

    this.logger.error('Repository clone failed', undefined, {
      requestId: context.requestId,
      repoUrl: body.repoUrl,
      errorCode: result.error.code,
      errorMessage: result.error.message
    });

    return this.createErrorResponse(result.error, context);
  }

  private async handleStatus(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitRepoPathRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.getStatus(body.repoPath, sessionId);

    if (!result.success) {
      return this.createErrorResponse(result.error, context);
    }

    const response: GitStatusResult = {
      success: true,
      repoPath: body.repoPath,
      currentBranch: result.data.currentBranch,
      ahead: result.data.ahead,
      behind: result.data.behind,
      branchPublished: result.data.branchPublished,
      fileStatus: result.data.fileStatus,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleListBranches(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitRepoPathRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.listBranches(body.repoPath, sessionId);

    if (!result.success) {
      return this.createErrorResponse(result.error, context);
    }

    const response: GitBranchListResult = {
      success: true,
      repoPath: body.repoPath,
      currentBranch: result.data.currentBranch,
      branches: result.data.branches,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }

  private async handleCheckoutBranch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitCheckoutBranchRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.checkoutBranch(
      body.repoPath,
      body.branch,
      sessionId
    );

    return this.createGitOperationResponse(body.repoPath, result, context);
  }

  private async handleCreateBranch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitCreateBranchRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.createBranch(
      body.repoPath,
      body.branch,
      sessionId
    );

    return this.createGitOperationResponse(body.repoPath, result, context);
  }

  private async handleDeleteBranch(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitDeleteBranchRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.deleteBranch(
      body.repoPath,
      body.branch,
      sessionId,
      { force: body.force }
    );

    return this.createGitOperationResponse(body.repoPath, result, context);
  }

  private async handleAdd(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitAddRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.add(body.repoPath, sessionId, {
      files: body.files,
      all: body.all
    });

    return this.createGitOperationResponse(body.repoPath, result, context);
  }

  private async handleCommit(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitCommitRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.commit(
      body.repoPath,
      body.message,
      sessionId,
      {
        authorName: body.authorName,
        authorEmail: body.authorEmail,
        allowEmpty: body.allowEmpty
      }
    );

    return this.createGitOperationResponse(body.repoPath, result, context);
  }

  private async handleReset(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitResetRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.reset(body.repoPath, sessionId, {
      mode: body.mode,
      target: body.target,
      paths: body.paths
    });

    return this.createGitOperationResponse(body.repoPath, result, context);
  }

  private async handleRestore(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<GitRestoreRequest>(request);
    const sessionId = body.sessionId || context.sessionId || 'default';

    const result = await this.gitService.restore(body.repoPath, sessionId, {
      paths: body.paths,
      staged: body.staged,
      worktree: body.worktree,
      source: body.source
    });

    return this.createGitOperationResponse(body.repoPath, result, context);
  }

  private createGitOperationResponse(
    repoPath: string,
    result: Awaited<ReturnType<GitService['checkoutBranch']>>,
    context: RequestContext
  ): Response {
    if (!result.success) {
      return this.createErrorResponse(result.error, context);
    }

    const response: GitOperationResult = {
      success: true,
      repoPath,
      timestamp: new Date().toISOString()
    };

    return this.createTypedResponse(response, context);
  }
}
