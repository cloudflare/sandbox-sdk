import type { Logger } from '@repo/shared';
import { sanitizeGitData, shellEscape } from '@repo/shared';
import type {
  GitErrorContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import {
  type CloneOptions,
  type ServiceError,
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../core/types';
import { GitManager } from '../managers/git-manager';
import type { SessionManager } from './session-manager';

export interface SecurityService {
  validateGitUrl(url: string): { isValid: boolean; errors: string[] };
  validatePath(path: string): { isValid: boolean; errors: string[] };
}

interface GitExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitService {
  private manager: GitManager;

  constructor(
    private security: SecurityService,
    private logger: Logger,
    private sessionManager: SessionManager
  ) {
    this.manager = new GitManager();
  }

  private buildCommand(args: string[]): string {
    return args.map((arg) => shellEscape(arg)).join(' ');
  }

  private returnError<T>(error: ServiceError): ServiceResult<T> {
    return serviceError<T>({
      ...error,
      details: sanitizeGitData(error.details ?? {})
    });
  }

  private returnSuccess<T>(data: T): ServiceResult<T> {
    return serviceSuccess(data);
  }

  private returnVoidSuccess(): ServiceResult<void> {
    return serviceSuccess(undefined) as ServiceResult<void>;
  }

  private validateRepoPath(repoPath: string): ServiceError | null {
    const pathValidation = this.security.validatePath(repoPath);
    if (pathValidation.isValid) {
      return null;
    }

    return {
      message: `Invalid repository path '${repoPath}': ${pathValidation.errors.join(', ')}`,
      code: ErrorCode.VALIDATION_FAILED,
      details: {
        validationErrors: pathValidation.errors.map((e) => ({
          field: 'repoPath',
          message: e,
          code: 'INVALID_PATH'
        }))
      } satisfies ValidationFailedContext
    };
  }

  private validateBranch(branch: string): ServiceError | null {
    const branchValidation = this.manager.validateBranchName(branch);
    if (branchValidation.isValid) {
      return null;
    }

    return {
      message: `Invalid branch name '${branch}': ${
        branchValidation.error || 'Invalid format'
      }`,
      code: ErrorCode.VALIDATION_FAILED,
      details: {
        validationErrors: [
          {
            field: 'branch',
            message: branchValidation.error || 'Invalid branch name format',
            code: 'INVALID_BRANCH'
          }
        ]
      } satisfies ValidationFailedContext
    };
  }

  private async runGitCommand(
    operation: string,
    repoPath: string,
    sessionId: string,
    args: string[],
    extraDetails: Record<string, unknown> = {}
  ): Promise<ServiceResult<GitExecResult>> {
    const command = this.buildCommand(args);
    const execResult = await this.sessionManager.executeInSession(
      sessionId,
      command,
      repoPath
    );

    if (!execResult.success) {
      this.logger.error('Git command execution failed', undefined, {
        operation,
        repoPath,
        sessionId,
        command,
        ...extraDetails,
        errorCode: execResult.error.code,
        errorMessage: execResult.error.message
      });
      return this.returnError(execResult.error);
    }

    const { exitCode, stdout, stderr } = execResult.data;

    if (exitCode !== 0) {
      const errorCode = this.manager.determineErrorCode(
        operation,
        stderr || 'Unknown error',
        exitCode
      );

      this.logger.error('Git command failed', undefined, {
        operation,
        repoPath,
        sessionId,
        command,
        exitCode,
        stderr,
        ...extraDetails
      });

      return this.returnError({
        message: this.manager.createErrorMessage(
          operation,
          { repoPath, ...extraDetails },
          stderr || `exit code ${exitCode}`
        ),
        code: errorCode,
        details: {
          targetDir: repoPath,
          exitCode,
          stderr,
          ...extraDetails
        } satisfies GitErrorContext
      });
    }

    return this.returnSuccess({ exitCode, stdout, stderr });
  }

  async cloneRepository(
    repoUrl: string,
    options: CloneOptions = {}
  ): Promise<ServiceResult<{ path: string; branch: string }>> {
    const urlValidation = this.security.validateGitUrl(repoUrl);
    if (!urlValidation.isValid) {
      return this.returnError({
        message: `Invalid Git URL '${repoUrl}': ${urlValidation.errors.join(', ')}`,
        code: ErrorCode.INVALID_GIT_URL,
        details: {
          validationErrors: urlValidation.errors.map((e) => ({
            field: 'repoUrl',
            message: e,
            code: 'INVALID_GIT_URL'
          }))
        } satisfies ValidationFailedContext
      });
    }

    const targetDirectory =
      options.targetDir || this.manager.generateTargetDirectory(repoUrl);

    const pathValidation = this.security.validatePath(targetDirectory);
    if (!pathValidation.isValid) {
      return this.returnError({
        message: `Invalid target directory '${targetDirectory}': ${pathValidation.errors.join(', ')}`,
        code: ErrorCode.VALIDATION_FAILED,
        details: {
          validationErrors: pathValidation.errors.map((e) => ({
            field: 'targetDirectory',
            message: e,
            code: 'INVALID_PATH'
          }))
        } satisfies ValidationFailedContext
      });
    }

    if (
      options.depth !== undefined &&
      (!Number.isInteger(options.depth) || options.depth <= 0)
    ) {
      return this.returnError({
        message: `Invalid depth value '${options.depth}': must be a positive integer`,
        code: ErrorCode.VALIDATION_FAILED,
        details: {
          validationErrors: [
            {
              field: 'depth',
              message: 'Depth must be a positive integer',
              code: 'INVALID_DEPTH'
            }
          ]
        } satisfies ValidationFailedContext
      });
    }

    const sessionId = options.sessionId || 'default';
    const cloneArgs = this.manager.buildCloneArgs(
      repoUrl,
      targetDirectory,
      options
    );
    const cloneCommand = this.buildCommand(cloneArgs);

    try {
      const result = await this.sessionManager.withSession(
        sessionId,
        async (exec) => {
          const cloneResult = await exec(cloneCommand);

          if (cloneResult.exitCode !== 0) {
            throw {
              message: `Failed to clone repository '${repoUrl}': ${
                cloneResult.stderr || `exit code ${cloneResult.exitCode}`
              }`,
              code: this.manager.determineErrorCode(
                'clone',
                cloneResult.stderr || 'Unknown error',
                cloneResult.exitCode
              ),
              details: {
                repository: repoUrl,
                targetDir: targetDirectory,
                exitCode: cloneResult.exitCode,
                stderr: cloneResult.stderr
              } satisfies GitErrorContext
            };
          }

          const branchCommand = this.buildCommand(
            this.manager.buildGetCurrentBranchArgs()
          );
          const branchResult = await exec(branchCommand, {
            cwd: targetDirectory
          });
          const branch =
            branchResult.exitCode === 0 && branchResult.stdout.trim().length > 0
              ? branchResult.stdout.trim()
              : options.branch || 'unknown';

          return { path: targetDirectory, branch };
        }
      );

      if (!result.success) {
        return this.returnError(result.error);
      }

      return this.returnSuccess(result.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to clone repository',
        error instanceof Error ? error : undefined,
        { repoUrl, options }
      );

      return this.returnError({
        message: `Failed to clone repository '${repoUrl}': ${message}`,
        code: ErrorCode.GIT_CLONE_FAILED,
        details: {
          repository: repoUrl,
          targetDir: options.targetDir,
          stderr: message
        } satisfies GitErrorContext
      });
    }
  }

  async checkoutBranch(
    repoPath: string,
    branch: string,
    sessionId = 'default'
  ): Promise<ServiceResult<void>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    const branchError = this.validateBranch(branch);
    if (branchError) return this.returnError(branchError);

    const result = await this.runGitCommand(
      'checkout',
      repoPath,
      sessionId,
      this.manager.buildCheckoutArgs(branch),
      { branch }
    );

    return result.success ? this.returnVoidSuccess() : result;
  }

  async createBranch(
    repoPath: string,
    branch: string,
    sessionId = 'default'
  ): Promise<ServiceResult<void>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    const branchError = this.validateBranch(branch);
    if (branchError) return this.returnError(branchError);

    const result = await this.runGitCommand(
      'createBranch',
      repoPath,
      sessionId,
      this.manager.buildCreateBranchArgs(branch),
      { branch }
    );

    return result.success ? this.returnVoidSuccess() : result;
  }

  async deleteBranch(
    repoPath: string,
    branch: string,
    sessionId = 'default',
    options?: { force?: boolean }
  ): Promise<ServiceResult<void>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    const branchError = this.validateBranch(branch);
    if (branchError) return this.returnError(branchError);

    const result = await this.runGitCommand(
      'deleteBranch',
      repoPath,
      sessionId,
      this.manager.buildDeleteBranchArgs(branch, options?.force),
      { branch, force: options?.force }
    );

    return result.success ? this.returnVoidSuccess() : result;
  }

  async add(
    repoPath: string,
    sessionId = 'default',
    options?: { files?: string[]; all?: boolean }
  ): Promise<ServiceResult<void>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    const result = await this.runGitCommand(
      'add',
      repoPath,
      sessionId,
      this.manager.buildAddArgs(options?.files, options?.all),
      { files: options?.files, all: options?.all }
    );

    return result.success ? this.returnVoidSuccess() : result;
  }

  async commit(
    repoPath: string,
    message: string,
    sessionId = 'default',
    options?: {
      authorName?: string;
      authorEmail?: string;
      allowEmpty?: boolean;
    }
  ): Promise<ServiceResult<void>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    if (!message || message.trim().length === 0) {
      return this.returnError({
        message: 'Commit message cannot be empty',
        code: ErrorCode.VALIDATION_FAILED,
        details: {
          validationErrors: [
            {
              field: 'message',
              message: 'Commit message cannot be empty',
              code: 'INVALID_COMMIT_MESSAGE'
            }
          ]
        } satisfies ValidationFailedContext
      });
    }

    const result = await this.runGitCommand(
      'commit',
      repoPath,
      sessionId,
      this.manager.buildCommitArgs(message, options),
      {
        authorName: options?.authorName,
        authorEmail: options?.authorEmail,
        allowEmpty: options?.allowEmpty
      }
    );

    return result.success ? this.returnVoidSuccess() : result;
  }

  async reset(
    repoPath: string,
    sessionId = 'default',
    options?: {
      mode?: 'soft' | 'mixed' | 'hard' | 'merge' | 'keep';
      target?: string;
      paths?: string[];
    }
  ): Promise<ServiceResult<void>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    try {
      const result = await this.runGitCommand(
        'reset',
        repoPath,
        sessionId,
        this.manager.buildResetArgs(options),
        {
          mode: options?.mode,
          target: options?.target,
          paths: options?.paths
        }
      );

      return result.success ? this.returnVoidSuccess() : result;
    } catch (error) {
      return this.returnError({
        message: `Invalid reset options: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
        code: ErrorCode.VALIDATION_FAILED,
        details: {
          validationErrors: [
            {
              field: 'mode',
              message:
                error instanceof Error
                  ? error.message
                  : 'Unknown validation error',
              code: 'INVALID_RESET_OPTIONS'
            }
          ]
        } satisfies ValidationFailedContext
      });
    }
  }

  async restore(
    repoPath: string,
    sessionId = 'default',
    options: {
      paths: string[];
      staged?: boolean;
      worktree?: boolean;
      source?: string;
    }
  ): Promise<ServiceResult<void>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    try {
      const result = await this.runGitCommand(
        'restore',
        repoPath,
        sessionId,
        this.manager.buildRestoreArgs(options),
        {
          paths: options.paths,
          staged: options.staged,
          worktree: options.worktree,
          source: options.source
        }
      );

      return result.success ? this.returnVoidSuccess() : result;
    } catch (error) {
      return this.returnError({
        message: `Invalid restore options: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
        code: ErrorCode.VALIDATION_FAILED,
        details: {
          validationErrors: [
            {
              field: 'restore',
              message:
                error instanceof Error
                  ? error.message
                  : 'Unknown validation error',
              code: 'INVALID_RESTORE_OPTIONS'
            }
          ]
        } satisfies ValidationFailedContext
      });
    }
  }

  async getCurrentBranch(
    repoPath: string,
    sessionId = 'default'
  ): Promise<ServiceResult<string>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    const result = await this.runGitCommand(
      'getCurrentBranch',
      repoPath,
      sessionId,
      this.manager.buildGetCurrentBranchArgs()
    );

    if (!result.success) {
      return result;
    }

    return this.returnSuccess(result.data.stdout.trim());
  }

  async listBranches(
    repoPath: string,
    sessionId = 'default'
  ): Promise<ServiceResult<{ branches: string[]; currentBranch: string }>> {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    const result = await this.runGitCommand(
      'listBranches',
      repoPath,
      sessionId,
      this.manager.buildListBranchesArgs()
    );

    if (!result.success) {
      return result;
    }

    return this.returnSuccess(
      this.manager.parseBranchSummary(result.data.stdout)
    );
  }

  async getStatus(
    repoPath: string,
    sessionId = 'default'
  ): Promise<
    ServiceResult<{
      currentBranch: string;
      ahead: number;
      behind: number;
      branchPublished: boolean;
      fileStatus: {
        path: string;
        indexStatus: string;
        workingTreeStatus: string;
      }[];
    }>
  > {
    const pathError = this.validateRepoPath(repoPath);
    if (pathError) return this.returnError(pathError);

    const result = await this.runGitCommand(
      'status',
      repoPath,
      sessionId,
      this.manager.buildStatusArgs()
    );

    if (!result.success) {
      return result;
    }

    return this.returnSuccess(this.manager.parseStatus(result.data.stdout));
  }
}
