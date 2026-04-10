/**
 * GitManager - Pure Business Logic for Git Operations
 *
 * Handles git operation logic without any I/O dependencies.
 * Extracted from GitService to enable fast unit testing.
 *
 * Responsibilities:
 * - Command argument building
 * - Branch output parsing
 * - Branch name validation
 * - Target directory generation
 * - Error code determination
 *
 * NO I/O operations - all infrastructure delegated to SessionManager via GitService
 */

import { DEFAULT_GIT_CLONE_TIMEOUT_MS, extractRepoName } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { CloneOptions } from '../core/types';

export { DEFAULT_GIT_CLONE_TIMEOUT_MS } from '@repo/shared';

const GIT_CLONE_KILL_GRACE_SECONDS = 5;

export function gitCloneTimeoutSeconds(timeoutMs: number): string {
  const timeoutSeconds = timeoutMs / 1000;
  return Number.isInteger(timeoutSeconds)
    ? String(timeoutSeconds)
    : timeoutSeconds
        .toFixed(3)
        .replace(/\.0+$/, '')
        .replace(/(\.\d*?)0+$/, '$1');
}

/**
 * GitManager contains pure business logic for git operations.
 * No Bun APIs, no I/O - just pure functions that can be unit tested instantly.
 */
export class GitManager {
  /**
   * Generate target directory for cloning
   * Format: /workspace/{repoName}
   *
   * Uses the repository name extracted from the URL as the directory name.
   * Clones to /workspace to match user expectations and keep files accessible.
   */
  generateTargetDirectory(repoUrl: string): string {
    return `/workspace/${extractRepoName(repoUrl)}`;
  }

  /**
   * Build git clone command arguments
   *
   * Wraps the command with `timeout -k 5 <seconds>` to enforce a wall-clock
   * limit, and configures git's own stalled-transfer detection via
   * http.lowSpeedLimit and http.lowSpeedTime.
   */
  buildCloneArgs(
    repoUrl: string,
    targetDir: string,
    options: CloneOptions = {}
  ): string[] {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS;
    const timeoutSeconds = gitCloneTimeoutSeconds(timeoutMs);
    const args = [
      'timeout',
      '-k',
      String(GIT_CLONE_KILL_GRACE_SECONDS),
      String(timeoutSeconds),
      'git',
      '-c',
      'http.lowSpeedLimit=1024',
      '-c',
      'http.lowSpeedTime=30',
      'clone',
      '--filter=blob:none'
    ];

    if (options.branch) {
      args.push('--branch', options.branch);
    }

    if (options.depth !== undefined) {
      args.push('--depth', String(options.depth));
    }

    args.push(repoUrl, targetDir);

    return args;
  }

  /**
   * Build git checkout command arguments
   */
  buildCheckoutArgs(branch: string): string[] {
    return ['git', 'checkout', branch];
  }

  /**
   * Build git branch --show-current command arguments
   */
  buildGetCurrentBranchArgs(): string[] {
    return ['git', 'branch', '--show-current'];
  }

  /**
   * Build git branch -a command arguments
   */
  buildListBranchesArgs(): string[] {
    return ['git', 'branch', '-a'];
  }

  /**
   * Parse git branch -a output into array of branch names
   * Handles:
   * - Current branch marker (*)
   * - Remote branch prefixes (remotes/origin/)
   * - HEAD references
   * - Duplicates
   */
  parseBranchList(stdout: string): string[] {
    const branches = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^\*\s*/, '')) // Remove current branch marker
      .map((line) => line.replace(/^remotes\/origin\//, '')) // Simplify remote branch names
      .filter((branch, index, array) => array.indexOf(branch) === index) // Remove duplicates
      .filter((branch) => branch !== 'HEAD'); // Remove HEAD reference

    return branches;
  }

  /**
   * Validate branch name
   */
  validateBranchName(branch: string): { isValid: boolean; error?: string } {
    if (!branch || branch.trim().length === 0) {
      return {
        isValid: false,
        error: 'Branch name cannot be empty'
      };
    }

    // Additional validation could be added here
    // (e.g., check for invalid characters, reserved names)

    return { isValid: true };
  }

  /**
   * Determine appropriate error code based on operation and error.
   * Returns valid ErrorCode enum values for use with withSession error handling.
   */
  determineErrorCode(
    operation: string,
    error: Error | string,
    exitCode?: number
  ): ErrorCode {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const lowerMessage = errorMessage.toLowerCase();

    // Exit code 124: timeout command killed the process
    if (exitCode === 124) {
      return ErrorCode.GIT_NETWORK_ERROR;
    }

    // Exit code 128: git-specific fatal errors
    if (exitCode === 128) {
      if (lowerMessage.includes('not a git repository')) {
        return ErrorCode.GIT_OPERATION_FAILED;
      }
      if (lowerMessage.includes('repository not found')) {
        return ErrorCode.GIT_REPOSITORY_NOT_FOUND;
      }
      return ErrorCode.GIT_OPERATION_FAILED;
    }

    // Common error patterns
    if (
      lowerMessage.includes('permission denied') ||
      lowerMessage.includes('access denied')
    ) {
      return ErrorCode.GIT_AUTH_FAILED;
    }

    if (
      lowerMessage.includes('not found') ||
      lowerMessage.includes('does not exist')
    ) {
      return ErrorCode.GIT_REPOSITORY_NOT_FOUND;
    }

    if (lowerMessage.includes('already exists')) {
      return ErrorCode.GIT_CLONE_FAILED;
    }

    if (
      lowerMessage.includes('did not match') ||
      lowerMessage.includes('pathspec')
    ) {
      return ErrorCode.GIT_BRANCH_NOT_FOUND;
    }

    if (
      lowerMessage.includes('authentication') ||
      lowerMessage.includes('credentials')
    ) {
      return ErrorCode.GIT_AUTH_FAILED;
    }

    // Operation-specific defaults
    switch (operation) {
      case 'clone':
        return ErrorCode.GIT_CLONE_FAILED;
      case 'checkout':
        return ErrorCode.GIT_CHECKOUT_FAILED;
      case 'getCurrentBranch':
      case 'listBranches':
        return ErrorCode.GIT_OPERATION_FAILED;
      default:
        return ErrorCode.GIT_OPERATION_FAILED;
    }
  }

  /**
   * Create standardized error message for git operations
   */
  createErrorMessage(
    operation: string,
    context: Record<string, any>,
    error: string
  ): string {
    const operationVerbs: Record<string, string> = {
      clone: 'clone repository',
      checkout: 'checkout branch',
      getCurrentBranch: 'get current branch',
      listBranches: 'list branches'
    };

    const verb = operationVerbs[operation] || 'perform git operation';
    const contextStr = Object.entries(context)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');

    return `Failed to ${verb} (${contextStr}): ${error}`;
  }

  /**
   * Check if git URL appears to be SSH format
   */
  isSshUrl(url: string): boolean {
    return (
      url.startsWith('git@') || (url.includes(':') && !url.startsWith('http'))
    );
  }

  /**
   * Check if git URL appears to be HTTPS format
   */
  isHttpsUrl(url: string): boolean {
    return url.startsWith('https://') || url.startsWith('http://');
  }
}
