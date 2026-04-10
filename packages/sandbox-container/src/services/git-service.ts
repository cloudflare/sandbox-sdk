// Git Operations Service

import {
  DEFAULT_GIT_CLONE_TIMEOUT_MS,
  type Logger,
  logCanonicalEvent,
  redactCommand,
  sanitizeGitData,
  shellEscape
} from '@repo/shared';
import type {
  GitErrorContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type { CloneOptions, ServiceError, ServiceResult } from '../core/types';
import { GitManager, gitCloneTimeoutSeconds } from '../managers/git-manager';
import type { SessionManager } from './session-manager';

export interface SecurityService {
  validateGitUrl(url: string): { isValid: boolean; errors: string[] };
  validatePath(path: string): { isValid: boolean; errors: string[] };
}

export class GitService {
  private manager: GitManager;

  constructor(
    private security: SecurityService,
    private sessionManager: SessionManager,
    private logger: Logger
  ) {
    this.manager = new GitManager();
  }

  /**
   * Build a shell command string from an array of arguments
   * Escapes all arguments to prevent command injection
   */
  private buildCommand(args: string[]): string {
    return args.map((arg) => shellEscape(arg)).join(' ');
  }

  /**
   * Create error result with sanitized data
   */
  private returnError<T>(error: ServiceError): ServiceResult<T> {
    return {
      success: false,
      error: sanitizeGitData(error)
    } as ServiceResult<T>;
  }

  /**
   * Create success result
   */
  private returnSuccess<T>(data: T): ServiceResult<T> {
    return {
      success: true,
      data
    } as ServiceResult<T>;
  }

  async cloneRepository(
    repoUrl: string,
    options: CloneOptions = {}
  ): Promise<ServiceResult<{ path: string; branch: string }>> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let errorMessage: string | undefined;
    const sessionId = options.sessionId || 'default';

    try {
      // Validate repository URL
      const urlValidation = this.security.validateGitUrl(repoUrl);
      if (!urlValidation.isValid) {
        errorMessage = `Invalid Git URL '${repoUrl}': ${urlValidation.errors.join(', ')}`;
        return this.returnError({
          message: errorMessage,
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

      // Generate target directory if not provided
      const targetDirectory =
        options.targetDir || this.manager.generateTargetDirectory(repoUrl);
      const cloneTimeoutMs = options.timeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS;

      if (!Number.isInteger(cloneTimeoutMs) || cloneTimeoutMs <= 0) {
        errorMessage = `Invalid clone timeout '${options.timeoutMs}'. Must be a positive integer representing milliseconds.`;
        return this.returnError({
          message: errorMessage,
          code: ErrorCode.VALIDATION_FAILED,
          details: {
            validationErrors: [
              {
                field: 'timeoutMs',
                message:
                  'Clone timeout must be a positive integer representing milliseconds',
                code: 'INVALID_TIMEOUT'
              }
            ]
          } satisfies ValidationFailedContext
        });
      }

      // Validate target directory path
      const pathValidation = this.security.validatePath(targetDirectory);
      if (!pathValidation.isValid) {
        errorMessage = `Invalid target directory '${targetDirectory}': ${pathValidation.errors.join(', ')}`;
        return this.returnError({
          message: errorMessage,
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

      // Build git clone command (via manager)
      const args = this.manager.buildCloneArgs(
        repoUrl,
        targetDirectory,
        options
      );
      const command = this.buildCommand(args);

      const result = await this.sessionManager
        .withSession(sessionId, async (exec) => {
          // Execute git clone
          const cloneResult = await exec(command, { origin: 'internal' });

          if (cloneResult.exitCode !== 0) {
            if (cloneResult.exitCode === 124) {
              throw {
                message: `Git clone timed out after ${gitCloneTimeoutSeconds(
                  cloneTimeoutMs
                )} seconds for '${redactCommand(repoUrl)}'`,
                code: ErrorCode.GIT_NETWORK_ERROR,
                details: {
                  repository: redactCommand(repoUrl),
                  targetDir: targetDirectory,
                  exitCode: 124,
                  stderr: 'Operation timed out'
                } satisfies GitErrorContext
              };
            }

            const errorCode = this.manager.determineErrorCode(
              'clone',
              cloneResult.stderr || 'Unknown error',
              cloneResult.exitCode
            );
            throw {
              message: `Failed to clone repository '${redactCommand(repoUrl)}': ${
                redactCommand(cloneResult.stderr || '') ||
                `exit code ${cloneResult.exitCode}`
              }`,
              code: errorCode,
              details: {
                repository: redactCommand(repoUrl),
                targetDir: targetDirectory,
                exitCode: cloneResult.exitCode,
                stderr: redactCommand(cloneResult.stderr || '')
              } satisfies GitErrorContext
            };
          }

          // Determine the actual branch that was checked out by querying Git
          // This ensures we always return the true current branch, whether it was
          // explicitly specified or defaulted to the repository's HEAD
          const branchArgs = this.manager.buildGetCurrentBranchArgs();
          const branchCommand = this.buildCommand(branchArgs);
          const branchResult = await exec(branchCommand, {
            cwd: targetDirectory,
            origin: 'internal'
          });

          let actualBranch: string;
          if (branchResult.exitCode === 0 && branchResult.stdout.trim()) {
            actualBranch = branchResult.stdout.trim();
          } else {
            // Fallback: use the requested branch or 'unknown'
            actualBranch = options.branch || 'unknown';
          }

          return {
            path: targetDirectory,
            branch: actualBranch
          };
        })
        .then((r) => {
          if (!r.success) {
            return r as ServiceResult<{ path: string; branch: string }>;
          }

          return this.returnSuccess(r.data);
        });

      outcome = result.success ? 'success' : 'error';
      if (!result.success) {
        errorMessage = result.error?.message;
      }
      return result;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;

      return this.returnError({
        message: `Failed to clone repository '${redactCommand(repoUrl)}': ${errorMessage}`,
        code: ErrorCode.GIT_CLONE_FAILED,
        details: {
          repository: redactCommand(repoUrl),
          targetDir: options.targetDir,
          stderr: errorMessage
        } satisfies GitErrorContext
      });
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'git.clone',
        outcome,
        durationMs: Date.now() - startTime,
        repoUrl: redactCommand(repoUrl),
        targetDir: options.targetDir,
        branch: options.branch,
        timeoutMs: options.timeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS,
        sessionId,
        errorMessage,
        error: caughtError
      });
    }
  }

  async checkoutBranch(
    repoPath: string,
    branch: string,
    sessionId = 'default'
  ): Promise<ServiceResult<void>> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let errorMessage: string | undefined;

    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        errorMessage = `Invalid repository path '${repoPath}': ${pathValidation.errors.join(', ')}`;
        return this.returnError({
          message: errorMessage,
          code: ErrorCode.VALIDATION_FAILED,
          details: {
            validationErrors: pathValidation.errors.map((e) => ({
              field: 'repoPath',
              message: e,
              code: 'INVALID_PATH'
            }))
          } satisfies ValidationFailedContext
        });
      }

      // Validate branch name (via manager)
      const branchValidation = this.manager.validateBranchName(branch);
      if (!branchValidation.isValid) {
        errorMessage = `Invalid branch name '${branch}': ${branchValidation.error || 'Invalid format'}`;
        return this.returnError({
          message: errorMessage,
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
        });
      }

      // Build git checkout command (via manager)
      const args = this.manager.buildCheckoutArgs(branch);
      const command = this.buildCommand(args);

      // Execute git checkout (via SessionManager)
      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command,
        { cwd: repoPath, origin: 'internal' }
      );

      if (!execResult.success) {
        outcome = 'error';
        errorMessage = execResult.error?.message;
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        const errorCode = this.manager.determineErrorCode(
          'checkout',
          result.stderr || 'Unknown error',
          result.exitCode
        );
        outcome = 'error';
        errorMessage = `Failed to checkout branch '${branch}' in '${repoPath}': ${result.stderr || `exit code ${result.exitCode}`}`;
        return this.returnError({
          message: errorMessage,
          code: errorCode,
          details: {
            branch,
            targetDir: repoPath,
            exitCode: result.exitCode,
            stderr: result.stderr
          } satisfies GitErrorContext
        });
      }

      outcome = 'success';
      return {
        success: true
      };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;

      return this.returnError({
        message: `Failed to checkout branch '${branch}' in '${repoPath}': ${errorMessage}`,
        code: ErrorCode.GIT_CHECKOUT_FAILED,
        details: {
          branch,
          targetDir: repoPath,
          stderr: errorMessage
        } satisfies GitErrorContext
      });
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'git.checkout',
        outcome,
        durationMs: Date.now() - startTime,
        repoPath,
        branch,
        sessionId,
        errorMessage,
        error: caughtError
      });
    }
  }

  async getCurrentBranch(
    repoPath: string,
    sessionId = 'default'
  ): Promise<ServiceResult<string>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return this.returnError({
          message: `Invalid repository path '${repoPath}': ${pathValidation.errors.join(', ')}`,
          code: ErrorCode.VALIDATION_FAILED,
          details: {
            validationErrors: pathValidation.errors.map((e) => ({
              field: 'repoPath',
              message: e,
              code: 'INVALID_PATH'
            }))
          } satisfies ValidationFailedContext
        });
      }

      // Build git branch --show-current command (via manager)
      const args = this.manager.buildGetCurrentBranchArgs();
      const command = this.buildCommand(args);

      // Execute command (via SessionManager)
      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command,
        { cwd: repoPath, origin: 'internal' }
      );

      if (!execResult.success) {
        return execResult as ServiceResult<string>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        const errorCode = this.manager.determineErrorCode(
          'getCurrentBranch',
          result.stderr || 'Unknown error',
          result.exitCode
        );
        return this.returnError({
          message: `Failed to get current branch in '${repoPath}': ${
            result.stderr || `exit code ${result.exitCode}`
          }`,
          code: errorCode,
          details: {
            targetDir: repoPath,
            exitCode: result.exitCode,
            stderr: result.stderr
          } satisfies GitErrorContext
        });
      }

      const currentBranch = result.stdout.trim();

      return this.returnSuccess(currentBranch);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return this.returnError({
        message: `Failed to get current branch in '${repoPath}': ${errorMessage}`,
        code: ErrorCode.GIT_OPERATION_FAILED,
        details: {
          targetDir: repoPath,
          stderr: errorMessage
        } satisfies GitErrorContext
      });
    }
  }

  async listBranches(
    repoPath: string,
    sessionId = 'default'
  ): Promise<ServiceResult<string[]>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return this.returnError({
          message: `Invalid repository path '${repoPath}': ${pathValidation.errors.join(', ')}`,
          code: ErrorCode.VALIDATION_FAILED,
          details: {
            validationErrors: pathValidation.errors.map((e) => ({
              field: 'repoPath',
              message: e,
              code: 'INVALID_PATH'
            }))
          } satisfies ValidationFailedContext
        });
      }

      // Build git branch -a command (via manager)
      const args = this.manager.buildListBranchesArgs();
      const command = this.buildCommand(args);

      // Execute command (via SessionManager)
      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command,
        { cwd: repoPath, origin: 'internal' }
      );

      if (!execResult.success) {
        return execResult as ServiceResult<string[]>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        const errorCode = this.manager.determineErrorCode(
          'listBranches',
          result.stderr || 'Unknown error',
          result.exitCode
        );
        return this.returnError({
          message: `Failed to list branches in '${repoPath}': ${
            result.stderr || `exit code ${result.exitCode}`
          }`,
          code: errorCode,
          details: {
            targetDir: repoPath,
            exitCode: result.exitCode,
            stderr: result.stderr
          } satisfies GitErrorContext
        });
      }

      // Parse branch output (via manager)
      const branches = this.manager.parseBranchList(result.stdout);

      return this.returnSuccess(branches);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return this.returnError({
        message: `Failed to list branches in '${repoPath}': ${errorMessage}`,
        code: ErrorCode.GIT_OPERATION_FAILED,
        details: {
          targetDir: repoPath,
          stderr: errorMessage
        } satisfies GitErrorContext
      });
    }
  }
}
