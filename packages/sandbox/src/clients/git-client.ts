import type { GitCheckoutResult } from '@repo/shared';
import {
  DEFAULT_GIT_CLONE_TIMEOUT_MS,
  extractRepoName,
  GitLogger
} from '@repo/shared';
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
  /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
  depth?: number;
  /** Maximum wall-clock time for the git clone subprocess in milliseconds */
  timeoutMs?: number;
}

/**
 * Client for Git repository operations
 */
export class GitClient extends BaseHttpClient {
  private static readonly REQUEST_TIMEOUT_BUFFER_MS = 30_000;

  constructor(options: HttpClientOptions = {}) {
    super(options);
    // Wrap logger with GitLogger to auto-redact credentials
    this.logger = new GitLogger(this.logger);
  }

  /**
   * Clone a Git repository
   * @param repoUrl - URL of the Git repository to clone
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (branch, targetDir, depth, timeoutMs)
   */
  async checkout(
    repoUrl: string,
    sessionId: string,
    options?: {
      branch?: string;
      targetDir?: string;
      /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
      depth?: number;
      /** Maximum wall-clock time for the git clone subprocess in milliseconds */
      timeoutMs?: number;
    }
  ): Promise<GitCheckoutResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS;

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

    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `Invalid timeout value: ${timeoutMs}. Must be a positive integer number of milliseconds.`
      );
    }

    data.timeoutMs = timeoutMs;

    const response = await this.post<GitCheckoutResult>(
      '/api/git/checkout',
      data,
      undefined,
      {
        requestTimeoutMs: timeoutMs + GitClient.REQUEST_TIMEOUT_BUFFER_MS
      }
    );

    return response;
  }
}
