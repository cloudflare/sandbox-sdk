// Session-Aware Git Operations Service
import type { CloneOptions, Logger, ServiceResult } from '../core/types';
import type { SessionManager } from '../isolation';
import { SessionAwareService } from './base/session-aware-service';

export interface SecurityService {
  validateGitUrl(url: string): { isValid: boolean; errors: string[] };
  validatePath(path: string): { isValid: boolean; errors: string[] };
  sanitizePath(path: string): string;
}

export class GitService extends SessionAwareService {
  constructor(
    private security: SecurityService,
    sessionManager: SessionManager,
    logger: Logger
  ) {
    super(sessionManager, logger);
  }

  async cloneRepository(repoUrl: string, sessionId?: string, options: CloneOptions = {}): Promise<ServiceResult<{ path: string; branch: string }>> {
    try {
      // Validate repository URL
      const urlValidation = this.security.validateGitUrl(repoUrl);
      if (!urlValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Git URL validation failed: ${urlValidation.errors.join(', ')}`,
            code: 'INVALID_GIT_URL',
            details: { repoUrl, errors: urlValidation.errors },
          },
        };
      }

      // Generate target directory if not provided
      const targetDirectory = options.targetDir || this.generateTargetDirectory(repoUrl);
      
      // Validate target directory path
      const pathValidation = this.security.validatePath(targetDirectory);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Target directory validation failed: ${pathValidation.errors.join(', ')}`,
            code: 'INVALID_TARGET_PATH',
            details: { targetDirectory, errors: pathValidation.errors },
          },
        };
      }

      this.logger.info('Cloning repository', { 
        repoUrl, 
        targetDirectory, 
        branch: options.branch 
      });

      // Build git clone command - ALL git clone logic consolidated here
      let command = 'git clone';
      
      if (options.branch) {
        command += ` --branch "${options.branch}"`;
      }
      
      command += ` "${repoUrl}" "${targetDirectory}"`;

      // Execute git clone using session-aware command execution
      const result = await this.executeInSession(command, sessionId);

      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Git clone session error: ${result.error.message}`,
            code: 'GIT_CLONE_SESSION_ERROR',
            details: { ...result.error.details, repoUrl, targetDirectory }
          }
        };
      }

      if (!result.data.success) {
        this.logger.error('Git clone failed in session-aware service', undefined, { 
          repoUrl, 
          targetDirectory, 
          exitCode: result.data?.exitCode,
          stderr: result.data?.stderr
        });

        return {
          success: false,
          error: {
            message: `Git clone operation failed: ${result.data.stderr || 'Command failed'}`,
            code: 'GIT_CLONE_FAILED',
            details: { 
              repoUrl, 
              targetDirectory, 
              exitCode: result.data.exitCode, 
              stderr: result.data.stderr,
              stdout: result.data.stdout,
              command: `git clone ${repoUrl} ${targetDirectory}`
            },
          },
        };
      }

      const branchUsed = options.branch || 'main'; // Default to main if no branch specified
      
      this.logger.info('Repository cloned successfully', { 
        repoUrl, 
        targetDirectory,
        branch: branchUsed 
      });

      return {
        success: true,
        data: {
          path: targetDirectory,
          branch: branchUsed
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to clone repository', error instanceof Error ? error : undefined, { repoUrl, options });

      return {
        success: false,
        error: {
          message: 'Failed to clone repository',
          code: 'GIT_CLONE_ERROR',
          details: { repoUrl, options, originalError: errorMessage },
        },
      };
    }
  }

  async checkoutBranch(repoPath: string, branch: string, sessionId?: string): Promise<ServiceResult<void>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Repository path validation failed: ${pathValidation.errors.join(', ')}`,
            code: 'INVALID_REPO_PATH',
            details: { repoPath, errors: pathValidation.errors },
          },
        };
      }

      // Validate branch name (basic validation)
      if (!branch || branch.trim().length === 0) {
        return {
          success: false,
          error: {
            message: 'Branch name cannot be empty',
            code: 'INVALID_BRANCH_NAME',
            details: { branch },
          },
        };
      }

      this.logger.info('Checking out branch', { repoPath, branch });

      // Execute git checkout using session-aware command - ALL checkout logic here
      const checkoutCommand = `cd "${repoPath}" && git checkout "${branch}"`;
      const result = await this.executeInSession(checkoutCommand, sessionId);

      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Git checkout session error: ${result.error.message}`,
            code: 'GIT_CHECKOUT_SESSION_ERROR',
            details: { ...result.error.details, repoPath, branch }
          }
        };
      }

      if (!result.data.success) {
        this.logger.error('Git checkout failed in session-aware service', undefined, { 
          repoPath, 
          branch, 
          exitCode: result.data?.exitCode,
          stderr: result.data?.stderr
        });

        return {
          success: false,
          error: {
            message: `Git checkout operation failed: ${result.data.stderr || 'Command failed'}`,
            code: 'GIT_CHECKOUT_FAILED',
            details: { 
              repoPath, 
              branch, 
              exitCode: result.data.exitCode, 
              stderr: result.data.stderr,
              stdout: result.data.stdout,
              command: `git checkout ${branch}`
            },
          },
        };
      }

      this.logger.info('Branch checked out successfully', { repoPath, branch });

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to checkout branch', error instanceof Error ? error : undefined, { repoPath, branch });

      return {
        success: false,
        error: {
          message: 'Failed to checkout branch',
          code: 'GIT_CHECKOUT_ERROR',
          details: { repoPath, branch, originalError: errorMessage },
        },
      };
    }
  }

  async getCurrentBranch(repoPath: string, sessionId?: string): Promise<ServiceResult<string>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Repository path validation failed: ${pathValidation.errors.join(', ')}`,
            code: 'INVALID_REPO_PATH',
            details: { repoPath, errors: pathValidation.errors },
          },
        };
      }

      // Get current branch using session-aware command - ALL branch detection logic here
      const branchCommand = `cd "${repoPath}" && git branch --show-current`;
      const result = await this.executeInSession(branchCommand, sessionId);

      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Get current branch session error: ${result.error.message}`,
            code: 'GIT_BRANCH_SESSION_ERROR',
            details: { ...result.error.details, repoPath }
          }
        };
      }

      if (!result.data.success) {
        return {
          success: false,
          error: {
            message: `Failed to get current branch`,
            code: 'GIT_BRANCH_ERROR',
            details: { 
              repoPath, 
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            },
          },
        };
      }

      const currentBranch = result.data.stdout.trim();

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
          message: 'Failed to get current branch',
          code: 'GIT_BRANCH_GET_ERROR',
          details: { repoPath, originalError: errorMessage },
        },
      };
    }
  }

  async listBranches(repoPath: string, sessionId?: string): Promise<ServiceResult<string[]>> {
    try {
      // Validate repository path
      const pathValidation = this.security.validatePath(repoPath);
      if (!pathValidation.isValid) {
        return {
          success: false,
          error: {
            message: `Repository path validation failed: ${pathValidation.errors.join(', ')}`,
            code: 'INVALID_REPO_PATH',
            details: { repoPath, errors: pathValidation.errors },
          },
        };
      }

      // List all branches using session-aware command - ALL branch listing logic here
      const listCommand = `cd "${repoPath}" && git branch -a`;
      const result = await this.executeInSession(listCommand, sessionId);

      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `List branches session error: ${result.error.message}`,
            code: 'GIT_BRANCH_LIST_SESSION_ERROR',
            details: { ...result.error.details, repoPath }
          }
        };
      }

      if (!result.data.success) {
        return {
          success: false,
          error: {
            message: `Failed to list branches`,
            code: 'GIT_BRANCH_LIST_ERROR',
            details: { 
              repoPath, 
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            },
          },
        };
      }

      // Parse branch output with enhanced error handling - ALL parsing logic here
      const branches = result.data.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^\*\s*/, '')) // Remove current branch marker
        .map(line => line.replace(/^remotes\/origin\//, '')) // Simplify remote branch names
        .filter((branch, index, array) => array.indexOf(branch) === index) // Remove duplicates
        .filter(branch => branch !== 'HEAD'); // Remove HEAD reference

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
          message: 'Failed to list branches',
          code: 'GIT_BRANCH_LIST_ERROR',
          details: { repoPath, originalError: errorMessage },
        },
      };
    }
  }

  private generateTargetDirectory(repoUrl: string): string {
    try {
      // Extract repository name from URL
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split('/');
      const repoName = pathParts[pathParts.length - 1].replace(/\.git$/, '');
      
      // Generate unique directory name
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      
      return `/tmp/git-clone-${repoName}-${timestamp}-${randomSuffix}`;
    } catch (error) {
      // Fallback if URL parsing fails
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      return `/tmp/git-clone-${timestamp}-${randomSuffix}`;
    }
  }
}