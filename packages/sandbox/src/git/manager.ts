/**
 * Pure git business logic for the git extension.
 *
 * No I/O — just command-argument building, output parsing, validation, and
 * error-code classification. Ported from the former container-side
 * `GitManager` so the extension can drive everything through `exec`.
 */

import { DEFAULT_GIT_CLONE_TIMEOUT_MS, extractRepoName } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { GitCheckoutOptions } from './types.js';

export { DEFAULT_GIT_CLONE_TIMEOUT_MS };

const GIT_CLONE_KILL_GRACE_SECONDS = 5;

/** Format a millisecond timeout as a `timeout(1)`-friendly seconds string. */
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
 * Generate the default target directory for a clone: `/workspace/<repoName>`.
 */
export function generateTargetDirectory(repoUrl: string): string {
  return `/workspace/${extractRepoName(repoUrl)}`;
}

/**
 * Build git clone command arguments.
 *
 * Wraps the command with `timeout -k 5 <seconds>` to enforce a wall-clock
 * limit, and configures git's own stalled-transfer detection via
 * `http.lowSpeedLimit` and `http.lowSpeedTime`.
 */
export function buildCloneArgs(
  repoUrl: string,
  targetDir: string,
  options: GitCheckoutOptions = {}
): string[] {
  const timeoutMs = options.cloneTimeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS;
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

export function buildCheckoutArgs(branch: string): string[] {
  return ['git', 'checkout', branch];
}

export function buildGetCurrentBranchArgs(): string[] {
  return ['git', 'branch', '--show-current'];
}

export function buildListBranchesArgs(): string[] {
  return ['git', 'branch', '-a'];
}

/**
 * Parse `git branch -a` output into a deduplicated array of branch names.
 * Strips the current-branch marker, the `remotes/origin/` prefix, and the
 * `HEAD` reference.
 */
export function parseBranchList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\*\s*/, ''))
    .map((line) => line.replace(/^remotes\/origin\//, ''))
    .filter((branch) => branch !== 'HEAD' && !branch.includes('->'))
    .filter((branch, index, array) => array.indexOf(branch) === index);
}

/** Validate a branch name (format only). */
export function validateBranchName(branch: string): {
  isValid: boolean;
  error?: string;
} {
  if (!branch || branch.trim().length === 0) {
    return { isValid: false, error: 'Branch name cannot be empty' };
  }
  return { isValid: true };
}

/** Validate a git URL (format only — no allowlist). */
export function validateGitUrl(url: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!url || typeof url !== 'string') {
    return { isValid: false, errors: ['Git URL must be a non-empty string'] };
  }

  const trimmedUrl = url.trim();

  if (trimmedUrl.length === 0) {
    errors.push('Git URL cannot be empty');
  }
  if (trimmedUrl.length > 2048) {
    errors.push('Git URL too long (max 2048 characters)');
  }
  if (trimmedUrl.includes('\0')) {
    errors.push('Git URL contains null bytes');
  }

  return { isValid: errors.length === 0, errors };
}

/** Validate a filesystem path (format only). */
export function validatePath(path: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!path || typeof path !== 'string') {
    return { isValid: false, errors: ['Path must be a non-empty string'] };
  }
  if (path.includes('\0')) {
    errors.push('Path contains null bytes');
  }
  if (path.length > 4096) {
    errors.push('Path too long (max 4096 characters)');
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Determine the appropriate {@link ErrorCode} for a failed git operation,
 * based on the operation, the stderr/error text, and the process exit code.
 */
export function determineErrorCode(
  operation: string,
  error: Error | string,
  exitCode?: number
): ErrorCode {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const lowerMessage = errorMessage.toLowerCase();

  // Exit code 124: timeout command killed the process.
  if (exitCode === 124) {
    return ErrorCode.GIT_NETWORK_ERROR;
  }

  // Exit code 128: git-specific fatal errors.
  if (exitCode === 128) {
    if (lowerMessage.includes('not a git repository')) {
      return ErrorCode.GIT_OPERATION_FAILED;
    }
    if (lowerMessage.includes('repository not found')) {
      return ErrorCode.GIT_REPOSITORY_NOT_FOUND;
    }
    return ErrorCode.GIT_OPERATION_FAILED;
  }

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

  switch (operation) {
    case 'clone':
      return ErrorCode.GIT_CLONE_FAILED;
    case 'checkout':
      return ErrorCode.GIT_CHECKOUT_FAILED;
    default:
      return ErrorCode.GIT_OPERATION_FAILED;
  }
}
