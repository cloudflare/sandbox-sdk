import type { GitCheckoutResult } from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { HttpClientOptions, SessionRequest } from './types';

// Re-export for convenience
export type { GitCheckoutResult };

/**
 * Request interface for Git checkout operations
 */
export interface GitCheckoutRequest extends SessionRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
}

/**
 * Client for Git repository operations
 */
export class GitClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super(options);
  }

  /**
   * Clone a Git repository
   * @param repoUrl - URL of the Git repository to clone
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (branch, targetDir)
   */
  async checkout(
    repoUrl: string,
    sessionId: string,
    options?: {
      branch?: string;
      targetDir?: string;
    }
  ): Promise<GitCheckoutResult> {
    try {
      // Determine target directory - use provided path or generate from repo name
      let targetDir = options?.targetDir;
      if (!targetDir) {
        const repoName = this.extractRepoName(repoUrl);
        // Ensure absolute path in /workspace
        targetDir = `/workspace/${repoName}`;
      }

      const data: GitCheckoutRequest = {
        repoUrl,
        sessionId,
        targetDir,
      };

      // Only include branch if explicitly specified
      // This allows Git to use the repository's default branch
      if (options?.branch) {
        data.branch = options.branch;
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

  /**
   * Extract repository name from URL for default directory name
   */
  private extractRepoName(repoUrl: string): string {
    try {
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split('/');
      const repoName = pathParts[pathParts.length - 1];
      
      // Remove .git extension if present
      return repoName.replace(/\.git$/, '');
    } catch {
      // Fallback for invalid URLs
      const parts = repoUrl.split('/');
      const repoName = parts[parts.length - 1];
      return repoName.replace(/\.git$/, '') || 'repo';
    }
  }
}