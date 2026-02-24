/**
 * GitManager - Pure Business Logic for Git Operations
 */

import type { GitStatusFile, GitStatusResult } from '@repo/shared';
import { extractRepoName } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { CloneOptions } from '../core/types';
import { GitBranchCommands } from './git-branch-commands';
import { GitWorkingTreeCommands } from './git-working-tree-commands';

export class GitManager {
  private readonly branchCommands = new GitBranchCommands();
  private readonly workingTreeCommands = new GitWorkingTreeCommands();

  generateTargetDirectory(repoUrl: string): string {
    return `/workspace/${extractRepoName(repoUrl)}`;
  }

  buildCloneArgs(
    repoUrl: string,
    targetDir: string,
    options: CloneOptions = {}
  ): string[] {
    const args = ['git', 'clone', '--filter=blob:none'];

    if (options.branch) {
      args.push('--branch', options.branch);
    }

    if (options.depth !== undefined) {
      args.push('--depth', String(options.depth));
    }

    args.push(repoUrl, targetDir);
    return args;
  }

  buildCheckoutArgs(branch: string): string[] {
    return this.branchCommands.buildCheckoutArgs(branch);
  }

  buildCreateBranchArgs(branch: string): string[] {
    return this.branchCommands.buildCreateBranchArgs(branch);
  }

  buildDeleteBranchArgs(branch: string, force = false): string[] {
    return this.branchCommands.buildDeleteBranchArgs(branch, force);
  }

  buildAddArgs(files?: string[], all = true): string[] {
    return this.workingTreeCommands.buildAddArgs(files, all);
  }

  buildCommitArgs(
    message: string,
    options?: {
      authorName?: string;
      authorEmail?: string;
      allowEmpty?: boolean;
    }
  ): string[] {
    return this.workingTreeCommands.buildCommitArgs(message, options);
  }

  buildResetArgs(options?: {
    mode?: 'soft' | 'mixed' | 'hard' | 'merge' | 'keep';
    target?: string;
    paths?: string[];
  }): string[] {
    return this.workingTreeCommands.buildResetArgs(options);
  }

  buildRestoreArgs(options: {
    paths: string[];
    staged?: boolean;
    worktree?: boolean;
    source?: string;
  }): string[] {
    return this.workingTreeCommands.buildRestoreArgs(options);
  }

  buildGetCurrentBranchArgs(): string[] {
    return this.branchCommands.buildGetCurrentBranchArgs();
  }

  buildListBranchesArgs(): string[] {
    return this.branchCommands.buildListBranchesArgs();
  }

  buildStatusArgs(): string[] {
    return this.workingTreeCommands.buildStatusArgs();
  }

  parseBranchSummary(stdout: string): {
    branches: string[];
    currentBranch: string;
  } {
    let currentBranch = 'HEAD';

    const branches = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const branchLine = line.replace(/^\*\s*/, '');
        if (line.startsWith('* ')) {
          currentBranch = this.normalizeCurrentBranch(branchLine);
        }

        return branchLine;
      })
      .map((line) => line.replace(/^remotes\/origin\//, ''))
      .filter((line) => !line.startsWith('HEAD'))
      .filter((line, index, array) => array.indexOf(line) === index);

    return {
      branches,
      currentBranch
    };
  }

  parseBranchList(stdout: string): string[] {
    return this.parseBranchSummary(stdout).branches;
  }

  parseStatus(
    stdout: string
  ): Pick<
    GitStatusResult,
    'currentBranch' | 'ahead' | 'behind' | 'branchPublished' | 'fileStatus'
  > {
    const lines = stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/\r$/, ''));

    const header = lines[0] ?? '';
    const statusLines = lines.slice(1);

    let currentBranch = 'HEAD';
    let ahead = 0;
    let behind = 0;
    let branchPublished = false;

    if (header.startsWith('## ')) {
      const branchInfo = header.slice(3);
      const trackingPart = branchInfo.split(' [')[0] || branchInfo;

      if (trackingPart.startsWith('HEAD ')) {
        currentBranch = 'HEAD';
      } else {
        const branchNamePart = trackingPart.split('...')[0]?.trim();
        if (branchNamePart && branchNamePart.length > 0) {
          currentBranch = this.normalizeCurrentBranch(branchNamePart);
        }
      }

      branchPublished =
        trackingPart.includes('...') && !branchInfo.includes('[gone]');

      const aheadMatch = branchInfo.match(/ahead\s+(\d+)/);
      const behindMatch = branchInfo.match(/behind\s+(\d+)/);
      ahead = aheadMatch ? Number.parseInt(aheadMatch[1] || '0', 10) : 0;
      behind = behindMatch ? Number.parseInt(behindMatch[1] || '0', 10) : 0;
    }

    const fileStatus: GitStatusFile[] = statusLines
      .map((line) => this.parseStatusLine(line))
      .filter((entry): entry is GitStatusFile => entry !== null);

    return {
      currentBranch,
      ahead,
      behind,
      branchPublished,
      fileStatus
    };
  }

  private normalizeCurrentBranch(branch: string): string {
    const trimmed = branch.trim();
    if (
      trimmed.startsWith('(HEAD detached') ||
      trimmed.startsWith('HEAD detached')
    ) {
      return 'HEAD';
    }

    return trimmed;
  }

  private parseStatusLine(line: string): GitStatusFile | null {
    if (line.length < 3) {
      return null;
    }

    const indexStatus = line[0] || ' ';
    const workingTreeStatus = line[1] || ' ';
    const rawPath = line.slice(3).trim();

    if (!rawPath) {
      return null;
    }

    const path = this.parsePorcelainPath(rawPath, indexStatus);

    return {
      path,
      indexStatus,
      workingTreeStatus
    };
  }

  private parsePorcelainPath(rawPath: string, indexStatus: string): string {
    if (
      (indexStatus === 'R' || indexStatus === 'C') &&
      rawPath.includes(' -> ')
    ) {
      const [, destination] = rawPath.split(' -> ');
      return this.normalizeQuotedPath(destination?.trim() || rawPath);
    }

    return this.normalizeQuotedPath(rawPath);
  }

  private normalizeQuotedPath(path: string): string {
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
      const unquoted = path.slice(1, -1);
      return unquoted.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    }

    return path;
  }

  validateBranchName(branch: string): { isValid: boolean; error?: string } {
    if (!branch || branch.trim().length === 0) {
      return {
        isValid: false,
        error: 'Branch name cannot be empty'
      };
    }

    return { isValid: true };
  }

  determineErrorCode(
    operation: string,
    error: Error | string,
    exitCode?: number
  ): ErrorCode {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const lowerMessage = errorMessage.toLowerCase();

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
      case 'createBranch':
      case 'deleteBranch':
        return ErrorCode.GIT_CHECKOUT_FAILED;
      case 'add':
      case 'commit':
      case 'reset':
      case 'restore':
      case 'status':
      case 'getCurrentBranch':
      case 'listBranches':
        return ErrorCode.GIT_OPERATION_FAILED;
      default:
        return ErrorCode.GIT_OPERATION_FAILED;
    }
  }

  createErrorMessage(
    operation: string,
    context: Record<string, unknown>,
    error: string
  ): string {
    const operationVerbs: Record<string, string> = {
      clone: 'clone repository',
      checkout: 'checkout branch',
      getCurrentBranch: 'get current branch',
      listBranches: 'list branches',
      status: 'get repository status',
      createBranch: 'create branch',
      deleteBranch: 'delete branch',
      add: 'stage changes',
      commit: 'commit changes',
      reset: 'reset repository',
      restore: 'restore repository files'
    };

    const verb = operationVerbs[operation] || 'perform git operation';
    const contextStr = Object.entries(context)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');

    return `Failed to ${verb} (${contextStr}): ${error}`;
  }

  isSshUrl(url: string): boolean {
    return (
      url.startsWith('git@') || (url.includes(':') && !url.startsWith('http'))
    );
  }

  isHttpsUrl(url: string): boolean {
    return url.startsWith('https://') || url.startsWith('http://');
  }
}
