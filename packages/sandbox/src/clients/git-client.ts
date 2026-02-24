import type {
  GitAddOptions,
  GitBranchListResult,
  GitCheckoutRequest,
  GitCheckoutResult,
  GitCommitOptions,
  GitOperationResult,
  GitResetOptions,
  GitRestoreOptions,
  GitStatusResult
} from '@repo/shared';
import { extractRepoName, GitLogger } from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { HttpClientOptions } from './types';

// Re-export for convenience
export type {
  GitAddOptions,
  GitBranchListResult,
  GitCheckoutResult,
  GitCommitOptions,
  GitOperationResult,
  GitResetOptions,
  GitRestoreOptions,
  GitStatusResult
};

/**
 * Client for Git repository operations
 */
export class GitClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super(options);
    // Wrap logger with GitLogger to auto-redact credentials
    this.logger = new GitLogger(this.logger);
  }

  private async postRepoPath<T>(
    endpoint: string,
    repoPath: string,
    sessionId: string,
    extra: Record<string, unknown> = {}
  ): Promise<T> {
    return this.post<T>(endpoint, {
      repoPath,
      sessionId,
      ...extra
    });
  }

  /**
   * Clone a Git repository
   * @param repoUrl - URL of the Git repository to clone
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (branch, targetDir, depth)
   */
  async checkout(
    repoUrl: string,
    sessionId: string,
    options?: {
      branch?: string;
      targetDir?: string;
      /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
      depth?: number;
    }
  ): Promise<GitCheckoutResult> {
    try {
      // Determine target directory - use provided path or generate from repo name
      let targetDir = options?.targetDir;
      if (!targetDir) {
        targetDir = `/workspace/${extractRepoName(repoUrl)}`;
      }

      const data: GitCheckoutRequest = {
        repoUrl,
        sessionId,
        targetDir
      };

      // Only include branch if explicitly specified
      // This allows Git to use the repository's default branch
      if (options?.branch) {
        data.branch = options.branch;
      }

      if (options?.depth !== undefined) {
        if (!Number.isInteger(options.depth) || options.depth <= 0) {
          throw new Error(
            `Invalid depth value: ${options.depth}. Must be a positive integer (e.g., 1, 5, 10).`
          );
        }
        data.depth = options.depth;
      }

      const response = await this.post<GitCheckoutResult>(
        '/api/git/checkout',
        data
      );

      this.logSuccess(
        'Repository cloned',
        `${repoUrl} (branch: ${response.branch}) -> ${response.targetDir}`
      );

      return response;
    } catch (error) {
      this.logError('checkout', error);
      throw error;
    }
  }

  async status(repoPath: string, sessionId: string): Promise<GitStatusResult> {
    return this.postRepoPath<GitStatusResult>(
      '/api/git/status',
      repoPath,
      sessionId
    );
  }

  async listBranches(
    repoPath: string,
    sessionId: string
  ): Promise<GitBranchListResult> {
    return this.postRepoPath<GitBranchListResult>(
      '/api/git/branches',
      repoPath,
      sessionId
    );
  }

  async checkoutBranch(
    repoPath: string,
    branch: string,
    sessionId: string
  ): Promise<GitOperationResult> {
    return this.postRepoPath<GitOperationResult>(
      '/api/git/checkout-branch',
      repoPath,
      sessionId,
      { branch }
    );
  }

  async createBranch(
    repoPath: string,
    branch: string,
    sessionId: string
  ): Promise<GitOperationResult> {
    return this.postRepoPath<GitOperationResult>(
      '/api/git/create-branch',
      repoPath,
      sessionId,
      { branch }
    );
  }

  async deleteBranch(
    repoPath: string,
    branch: string,
    sessionId: string,
    options?: { force?: boolean }
  ): Promise<GitOperationResult> {
    return this.postRepoPath<GitOperationResult>(
      '/api/git/delete-branch',
      repoPath,
      sessionId,
      { branch, force: options?.force }
    );
  }

  async add(
    repoPath: string,
    sessionId: string,
    options?: GitAddOptions
  ): Promise<GitOperationResult> {
    return this.postRepoPath<GitOperationResult>(
      '/api/git/add',
      repoPath,
      sessionId,
      { files: options?.files, all: options?.all }
    );
  }

  async commit(
    repoPath: string,
    message: string,
    sessionId: string,
    options?: GitCommitOptions
  ): Promise<GitOperationResult> {
    return this.postRepoPath<GitOperationResult>(
      '/api/git/commit',
      repoPath,
      sessionId,
      {
        message,
        authorName: options?.authorName,
        authorEmail: options?.authorEmail,
        allowEmpty: options?.allowEmpty
      }
    );
  }

  async reset(
    repoPath: string,
    sessionId: string,
    options?: GitResetOptions
  ): Promise<GitOperationResult> {
    return this.postRepoPath<GitOperationResult>(
      '/api/git/reset',
      repoPath,
      sessionId,
      {
        mode: options?.mode,
        target: options?.target,
        paths: options?.paths
      }
    );
  }

  async restore(
    repoPath: string,
    sessionId: string,
    options: GitRestoreOptions
  ): Promise<GitOperationResult> {
    return this.postRepoPath<GitOperationResult>(
      '/api/git/restore',
      repoPath,
      sessionId,
      {
        paths: options.paths,
        staged: options.staged,
        worktree: options.worktree,
        source: options.source
      }
    );
  }
}
