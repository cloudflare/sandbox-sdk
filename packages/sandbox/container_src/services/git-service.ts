// Git Operations Service
import type { CloneOptions, Logger, ServiceResult } from '../core/types';

export interface SecurityService {
  validateGitUrl(url: string): { isValid: boolean; errors: string[] };
  validatePath(path: string): { isValid: boolean; errors: string[] };
  sanitizePath(path: string): string;
}

export class GitService {
  constructor(
    private security: SecurityService,
    private logger: Logger
  ) {}

  async cloneRepository(repoUrl: string, options: CloneOptions = {}): Promise<ServiceResult<{ path: string; branch: string }>> {
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

      // Build git clone command
      const args = ['git', 'clone'];
      
      if (options.branch) {
        args.push('--branch', options.branch);
      }
      
      args.push(repoUrl, targetDirectory);

      // Execute git clone using Bun.spawn for better performance
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      await proc.exited;

      if (proc.exitCode !== 0) {
        this.logger.error('Git clone failed', undefined, { 
          repoUrl, 
          targetDirectory, 
          exitCode: proc.exitCode,
          stderr 
        });

        return {
          success: false,
          error: {
            message: 'Git clone operation failed',
            code: 'GIT_CLONE_FAILED',
            details: { 
              repoUrl, 
              targetDirectory, 
              exitCode: proc.exitCode, 
              stderr,
              stdout 
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

  async checkoutBranch(repoPath: string, branch: string): Promise<ServiceResult<void>> {
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

      // Execute git checkout
      const proc = Bun.spawn(['git', 'checkout', branch], {
        cwd: repoPath,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      await proc.exited;

      if (proc.exitCode !== 0) {
        this.logger.error('Git checkout failed', undefined, { 
          repoPath, 
          branch, 
          exitCode: proc.exitCode,
          stderr 
        });

        return {
          success: false,
          error: {
            message: 'Git checkout operation failed',
            code: 'GIT_CHECKOUT_FAILED',
            details: { 
              repoPath, 
              branch, 
              exitCode: proc.exitCode, 
              stderr,
              stdout 
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

  async getCurrentBranch(repoPath: string): Promise<ServiceResult<string>> {
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

      // Get current branch
      const proc = Bun.spawn(['git', 'branch', '--show-current'], {
        cwd: repoPath,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: 'Failed to get current branch',
            code: 'GIT_BRANCH_ERROR',
            details: { repoPath, exitCode: proc.exitCode },
          },
        };
      }

      const currentBranch = stdout.trim();

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

  async listBranches(repoPath: string): Promise<ServiceResult<string[]>> {
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

      // List all branches
      const proc = Bun.spawn(['git', 'branch', '-a'], {
        cwd: repoPath,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: 'Failed to list branches',
            code: 'GIT_BRANCH_LIST_ERROR',
            details: { repoPath, exitCode: proc.exitCode },
          },
        };
      }

      // Parse branch output
      const branches = stdout
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

  private extractRepoName(repoUrl: string): string {
    try {
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split('/');
      return pathParts[pathParts.length - 1].replace(/\.git$/, '');
    } catch (error) {
      return 'unknown-repo';
    }
  }
}