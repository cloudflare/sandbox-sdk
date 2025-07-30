import { BaseHttpClient } from './base-client';
import type { BaseApiResponse, HttpClientOptions, SessionRequest } from './types';

/**
 * Request interface for Git checkout operations
 */
export interface GitCheckoutRequest extends SessionRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
}

/**
 * Response interface for Git checkout operations
 */
export interface GitCheckoutResponse extends BaseApiResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  repoUrl: string;
  branch: string;
  targetDir: string;
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
   */
  async checkout(
    repoUrl: string,
    options?: {
      branch?: string;
      targetDir?: string;
      sessionId?: string;
    }
  ): Promise<GitCheckoutResponse> {
    try {
      const data = this.withSession({
        repoUrl,
        branch: options?.branch || 'main',
        targetDir: options?.targetDir || this.extractRepoName(repoUrl),
      }, options?.sessionId);

      const response = await this.postJson<GitCheckoutResponse>(
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