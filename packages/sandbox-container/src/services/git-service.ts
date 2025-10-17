// Git Operations Service

import type { Logger } from '@repo/shared';
import type {
  GitErrorContext,
  ValidationFailedContext,
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type { CloneOptions, ServiceResult } from '../core/types';
import { GitManager } from '../managers/git-manager';
import type { SessionManager } from './session-manager';

export interface SecurityService {
  validateGitUrl(url: string): { isValid: boolean; errors: string[] };
  validatePath(path: string): { isValid: boolean; errors: string[] };
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

  /**
   * Build a shell command string from an array of arguments
   * Quotes arguments that contain spaces for safe shell execution
   */
  private buildCommand(args: string[]): string {
    return args.map(arg => {
      if (arg.includes(' ')) {
        return `"${arg}"`;
      }
      return arg;
    }).join(' ');
  }

  async cloneRepository(repoUrl: string, options: CloneOptions = {}): Promise<ServiceResult<{ path: string; branch: string }>> {
    try {
      // Validate repository URL
      const urlValidation = this.security.validateGitUrl(repoUrl);
      if (!urlValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid Git URL '${repoUrl}': ${urlValidation.errors.join(', ')}`,
            code: ErrorCode.INVALID_GIT_URL,
            details: {
              validationErrors: urlValidation.errors.map(e => ({
                field: 'repoUrl',
                message: e,
                code: 'INVALID_GIT_URL'
              }))
            } satisfies ValidationFailedContext,
          },
        };
      }

      // Generate target directory if not provided
      const targetDirectory = options.targetDir || this.manager.generateTargetDirectory(repoUrl);

      // Validate target directory path
      const pathValidation = this.security.validatePath(targetDirectory);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid target directory '${targetDirectory}': ${pathValidation.errors.join(', ')}`,
            code: ErrorCode.VALIDATION_FAILED,
            details: {
              validationErrors: pathValidation.errors.map(e => ({
                field: 'targetDirectory',
                message: e,
                code: 'INVALID_PATH'
              }))
            } satisfies ValidationFailedContext,
          },
        };
      }

      // Build git clone command (via manager)
      const args = this.manager.buildCloneArgs(repoUrl, targetDirectory, options);
      const command = this.buildCommand(args);

      // Execute git clone (via SessionManager)
      const sessionId = options.sessionId || 'default';
      const execResult = await this.sessionManager.executeInSession(sessionId, command);

      if (!execResult.success) {
        return execResult as ServiceResult<{ path: string; branch: string }>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        this.logger.error('Git clone failed', undefined, {
          repoUrl,
          targetDirectory,
          exitCode: result.exitCode,
          stderr: result.stderr
        });

        const errorCode = this.manager.determineErrorCode('clone', result.stderr || 'Unknown error', result.exitCode);
        return {
          success: false,
          error: {
            message: `Failed to clone repository '${repoUrl}': ${result.stderr || `exit code ${result.exitCode}`}`,
            code: errorCode,
            details: {
              repository: repoUrl,
              targetDir: targetDirectory,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies GitErrorContext,
          },
        };
      }

      // Determine the actual branch that was checked out by querying Git
      // This ensures we always return the true current branch, whether it was
      // explicitly specified or defaulted to the repository's HEAD
      const branchArgs = this.manager.buildGetCurrentBranchArgs();
      const branchCommand = this.buildCommand(branchArgs);
      const branchExecResult = await this.sessionManager.executeInSession(sessionId, branchCommand, targetDirectory);

      if (!branchExecResult.success) {
        // If we can't get the branch, use fallback but don't fail the entire operation
        const actualBranch = options.branch || 'unknown';

        return {
          success: true,
          data: {
            path: targetDirectory,
            branch: actualBranch
          },
        };
      }

      const branchResult = branchExecResult.data;

      let actualBranch: string;
      if (branchResult.exitCode === 0 && branchResult.stdout.trim()) {
        actualBranch = branchResult.stdout.trim();
      } else {
        // Fallback: use the requested branch or 'unknown'
        actualBranch = options.branch || 'unknown';
      }

      return {
        success: true,
        data: {
          path: targetDirectory,
          branch: actualBranch
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to clone repository', error instanceof Error ? error : undefined, { repoUrl, options });

      return {
        success: false,
        error: {
          message: `Failed to clone repository '${repoUrl}': ${errorMessage}`,
          code: ErrorCode.GIT_CLONE_FAILED,
          details: {
            repository: repoUrl,
            targetDir: options.targetDir,
            stderr: errorMessage
          } satisfies GitErrorContext,
        },
      };
    }
  }

  async checkoutBranch(repoPath: string, branch: string, sessionId = 'default'): Promise<ServiceResult<void>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid repository path '${repoPath}': ${pathValidation.errors.join(', ')}`,
            code: ErrorCode.VALIDATION_FAILED,
            details: {
              validationErrors: pathValidation.errors.map(e => ({
                field: 'repoPath',
                message: e,
                code: 'INVALID_PATH'
              }))
            } satisfies ValidationFailedContext,
          },
        };
      }

      // Validate branch name (via manager)
      const branchValidation = this.manager.validateBranchName(branch);
      if (!branchValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid branch name '${branch}': ${branchValidation.error || 'Invalid format'}`,
            code: ErrorCode.VALIDATION_FAILED,
            details: {
              validationErrors: [{
                field: 'branch',
                message: branchValidation.error || 'Invalid branch name format',
                code: 'INVALID_BRANCH'
              }]
            } satisfies ValidationFailedContext,
          },
        };
      }

      // Build git checkout command (via manager)
      const args = this.manager.buildCheckoutArgs(branch);
      const command = this.buildCommand(args);

      // Execute git checkout (via SessionManager)
      const execResult = await this.sessionManager.executeInSession(sessionId, command, repoPath);

      if (!execResult.success) {
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        this.logger.error('Git checkout failed', undefined, {
          repoPath,
          branch,
          exitCode: result.exitCode,
          stderr: result.stderr
        });

        const errorCode = this.manager.determineErrorCode('checkout', result.stderr || 'Unknown error', result.exitCode);
        return {
          success: false,
          error: {
            message: `Failed to checkout branch '${branch}' in '${repoPath}': ${result.stderr || `exit code ${result.exitCode}`}`,
            code: errorCode,
            details: {
              branch,
              targetDir: repoPath,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies GitErrorContext,
          },
        };
      }

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to checkout branch', error instanceof Error ? error : undefined, { repoPath, branch });

      return {
        success: false,
        error: {
          message: `Failed to checkout branch '${branch}' in '${repoPath}': ${errorMessage}`,
          code: ErrorCode.GIT_CHECKOUT_FAILED,
          details: {
            branch,
            targetDir: repoPath,
            stderr: errorMessage
          } satisfies GitErrorContext,
        },
      };
    }
  }

  async getCurrentBranch(repoPath: string, sessionId = 'default'): Promise<ServiceResult<string>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid repository path '${repoPath}': ${pathValidation.errors.join(', ')}`,
            code: ErrorCode.VALIDATION_FAILED,
            details: {
              validationErrors: pathValidation.errors.map(e => ({
                field: 'repoPath',
                message: e,
                code: 'INVALID_PATH'
              }))
            } satisfies ValidationFailedContext,
          },
        };
      }

      // Build git branch --show-current command (via manager)
      const args = this.manager.buildGetCurrentBranchArgs();
      const command = this.buildCommand(args);

      // Execute command (via SessionManager)
      const execResult = await this.sessionManager.executeInSession(sessionId, command, repoPath);

      if (!execResult.success) {
        return execResult as ServiceResult<string>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        const errorCode = this.manager.determineErrorCode('getCurrentBranch', result.stderr || 'Unknown error', result.exitCode);
        return {
          success: false,
          error: {
            message: `Failed to get current branch in '${repoPath}': ${result.stderr || `exit code ${result.exitCode}`}`,
            code: errorCode,
            details: {
              targetDir: repoPath,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies GitErrorContext,
          },
        };
      }

      const currentBranch = result.stdout.trim();

      return {
        success: true,
        data: currentBranch,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to get current branch', error instanceof Error ? error : undefined, { repoPath });

      return {
        success: false,
        error: {
          message: `Failed to get current branch in '${repoPath}': ${errorMessage}`,
          code: ErrorCode.GIT_OPERATION_FAILED,
          details: {
            targetDir: repoPath,
            stderr: errorMessage
          } satisfies GitErrorContext,
        },
      };
    }
  }

  async listBranches(repoPath: string, sessionId = 'default'): Promise<ServiceResult<string[]>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid repository path '${repoPath}': ${pathValidation.errors.join(', ')}`,
            code: ErrorCode.VALIDATION_FAILED,
            details: {
              validationErrors: pathValidation.errors.map(e => ({
                field: 'repoPath',
                message: e,
                code: 'INVALID_PATH'
              }))
            } satisfies ValidationFailedContext,
          },
        };
      }

      // Build git branch -a command (via manager)
      const args = this.manager.buildListBranchesArgs();
      const command = this.buildCommand(args);

      // Execute command (via SessionManager)
      const execResult = await this.sessionManager.executeInSession(sessionId, command, repoPath);

      if (!execResult.success) {
        return execResult as ServiceResult<string[]>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        const errorCode = this.manager.determineErrorCode('listBranches', result.stderr || 'Unknown error', result.exitCode);
        return {
          success: false,
          error: {
            message: `Failed to list branches in '${repoPath}': ${result.stderr || `exit code ${result.exitCode}`}`,
            code: errorCode,
            details: {
              targetDir: repoPath,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies GitErrorContext,
          },
        };
      }

      // Parse branch output (via manager)
      const branches = this.manager.parseBranchList(result.stdout);

      return {
        success: true,
        data: branches,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to list branches', error instanceof Error ? error : undefined, { repoPath });

      return {
        success: false,
        error: {
          message: `Failed to list branches in '${repoPath}': ${errorMessage}`,
          code: ErrorCode.GIT_OPERATION_FAILED,
          details: {
            targetDir: repoPath,
            stderr: errorMessage
          } satisfies GitErrorContext,
        },
      };
    }
  }

}