import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ErrorCode } from '@repo/shared/errors';
import { GitManager } from '@sandbox-container/managers/git-manager';

describe('GitManager', () => {
  let manager: GitManager;

  beforeEach(() => {
    manager = new GitManager();
  });

  describe('generateTargetDirectory', () => {
    it('should generate directory in /workspace with repo name', () => {
      const dir = manager.generateTargetDirectory(
        'https://github.com/user/repo.git'
      );

      expect(dir).toBe('/workspace/repo');
    });

    it('should generate consistent directories for same URL', () => {
      const dir1 = manager.generateTargetDirectory(
        'https://github.com/user/repo.git'
      );
      const dir2 = manager.generateTargetDirectory(
        'https://github.com/user/repo.git'
      );

      expect(dir1).toBe(dir2);
    });

    it('should handle invalid URLs with fallback name', () => {
      const dir = manager.generateTargetDirectory('invalid-url');

      expect(dir).toBe('/workspace/repository');
    });
  });

  describe('buildCloneArgs', () => {
    it('should build basic clone args', () => {
      const args = manager.buildCloneArgs(
        'https://github.com/user/repo.git',
        '/tmp/target',
        {}
      );
      expect(args).toEqual([
        'git',
        'clone',
        '--filter=blob:none',
        'https://github.com/user/repo.git',
        '/tmp/target'
      ]);
    });

    it('should build clone args with branch option', () => {
      const args = manager.buildCloneArgs(
        'https://github.com/user/repo.git',
        '/tmp/target',
        { branch: 'develop' }
      );
      expect(args).toEqual([
        'git',
        'clone',
        '--filter=blob:none',
        '--branch',
        'develop',
        'https://github.com/user/repo.git',
        '/tmp/target'
      ]);
    });

    it('should build clone args with depth option for shallow clone', () => {
      const args = manager.buildCloneArgs(
        'https://github.com/user/repo.git',
        '/tmp/target',
        { depth: 1 }
      );
      expect(args).toEqual([
        'git',
        'clone',
        '--filter=blob:none',
        '--depth',
        '1',
        'https://github.com/user/repo.git',
        '/tmp/target'
      ]);
    });

    it('should build clone args with both branch and depth options', () => {
      const args = manager.buildCloneArgs(
        'https://github.com/user/repo.git',
        '/tmp/target',
        { branch: 'main', depth: 10 }
      );
      expect(args).toEqual([
        'git',
        'clone',
        '--filter=blob:none',
        '--branch',
        'main',
        '--depth',
        '10',
        'https://github.com/user/repo.git',
        '/tmp/target'
      ]);
    });

    it('should pass through depth value to git command', () => {
      const args = manager.buildCloneArgs(
        'https://github.com/user/repo.git',
        '/tmp/target',
        { depth: 5 }
      );
      expect(args).toEqual([
        'git',
        'clone',
        '--filter=blob:none',
        '--depth',
        '5',
        'https://github.com/user/repo.git',
        '/tmp/target'
      ]);
    });
  });

  describe('buildCheckoutArgs', () => {
    it('should build checkout args with branch names', () => {
      expect(manager.buildCheckoutArgs('develop')).toEqual([
        'git',
        'checkout',
        'develop'
      ]);
      expect(manager.buildCheckoutArgs('feature/new-feature')).toEqual([
        'git',
        'checkout',
        'feature/new-feature'
      ]);
    });
  });

  describe('buildDeleteBranchArgs', () => {
    it('should include -- separator before branch name', () => {
      expect(manager.buildDeleteBranchArgs('feature/old')).toEqual([
        'git',
        'branch',
        '-d',
        '--',
        'feature/old'
      ]);
    });

    it('should use -D for force delete with -- separator', () => {
      expect(manager.buildDeleteBranchArgs('feature/old', true)).toEqual([
        'git',
        'branch',
        '-D',
        '--',
        'feature/old'
      ]);
    });
  });

  describe('buildAddArgs', () => {
    it('should default to git add -A when no options given', () => {
      expect(manager.buildAddArgs()).toEqual(['git', 'add', '-A']);
    });

    it('should stage specific files with -- separator', () => {
      expect(manager.buildAddArgs(['src/a.ts', 'src/b.ts'])).toEqual([
        'git',
        'add',
        '--',
        'src/a.ts',
        'src/b.ts'
      ]);
    });

    it('should stage specific files even when all is false', () => {
      expect(manager.buildAddArgs(['src/a.ts'], false)).toEqual([
        'git',
        'add',
        '--',
        'src/a.ts'
      ]);
    });

    it('should throw when all is false and no files are provided', () => {
      expect(() => manager.buildAddArgs(undefined, false)).toThrow(
        'Either files must be specified or all must be true'
      );
      expect(() => manager.buildAddArgs([], false)).toThrow(
        'Either files must be specified or all must be true'
      );
    });
  });

  describe('buildGetCurrentBranchArgs', () => {
    it('should build get current branch args', () => {
      expect(manager.buildGetCurrentBranchArgs()).toEqual([
        'git',
        'branch',
        '--show-current'
      ]);
    });
  });

  describe('buildListBranchesArgs', () => {
    it('should build list branches args', () => {
      expect(manager.buildListBranchesArgs()).toEqual(['git', 'branch', '-a']);
    });
  });

  describe('parseBranchList', () => {
    it('should parse and deduplicate branch list with remote branches', () => {
      const output = `  develop
* main
  remotes/origin/develop
  remotes/origin/main
  remotes/origin/feature/auth`;
      expect(manager.parseBranchList(output)).toEqual([
        'develop',
        'main',
        'feature/auth'
      ]);
    });

    it('should filter out HEAD references', () => {
      const output = `  develop
* main
  remotes/origin/HEAD -> origin/main
  remotes/origin/main`;
      const branches = manager.parseBranchList(output);
      expect(branches).not.toContain('HEAD');
      expect(branches).not.toContain('HEAD -> origin/main');
    });

    it('should return current branch from summary', () => {
      const summary = manager.parseBranchSummary(`  develop
* main
  remotes/origin/main`);
      expect(summary.currentBranch).toBe('main');
      expect(summary.branches).toEqual(['develop', 'main']);
    });

    it('should normalize detached HEAD branch summary', () => {
      const summary = manager.parseBranchSummary(`* (HEAD detached at abc123)
  main`);
      expect(summary.currentBranch).toBe('HEAD');
      expect(summary.branches).toEqual(['main']);
    });

    it('should handle empty and single branch lists', () => {
      expect(manager.parseBranchList('\n\n  \n')).toEqual([]);
      expect(manager.parseBranchList('* main')).toEqual(['main']);
    });
  });

  describe('parseStatus', () => {
    it('should parse ahead/behind and file states', () => {
      const status =
        manager.parseStatus(`## main...origin/main [ahead 2, behind 1]
M  src/app.ts
 M README.md
?? docs/new.md`);

      expect(status.currentBranch).toBe('main');
      expect(status.ahead).toBe(2);
      expect(status.behind).toBe(1);
      expect(status.branchPublished).toBe(true);
      expect(status.fileStatus).toEqual([
        { path: 'src/app.ts', indexStatus: 'M', workingTreeStatus: ' ' },
        { path: 'README.md', indexStatus: ' ', workingTreeStatus: 'M' },
        { path: 'docs/new.md', indexStatus: '?', workingTreeStatus: '?' }
      ]);
    });

    it('should parse rename and detached head', () => {
      const status = manager.parseStatus(`## HEAD (no branch)
R  old.txt -> new.txt`);

      expect(status.currentBranch).toBe('HEAD');
      expect(status.branchPublished).toBe(false);
      expect(status.fileStatus).toEqual([
        { path: 'new.txt', indexStatus: 'R', workingTreeStatus: ' ' }
      ]);
    });

    it('should parse conflict markers', () => {
      const status = manager.parseStatus(`## feature
UU conflict.ts`);

      expect(status.fileStatus).toEqual([
        { path: 'conflict.ts', indexStatus: 'U', workingTreeStatus: 'U' }
      ]);
    });
  });

  describe('status fixture coverage', () => {
    it('should parse merge-conflict fixture output', () => {
      const output = readFileSync(
        new URL('./../fixtures/git-status/merge-conflict.txt', import.meta.url),
        'utf8'
      );

      const parsed = manager.parseStatus(output);

      expect(parsed.currentBranch).toBe('feature/merge-fix');
      expect(parsed.ahead).toBe(2);
      expect(parsed.behind).toBe(1);
      expect(parsed.fileStatus).toEqual([
        { path: 'src/conflict.ts', indexStatus: 'U', workingTreeStatus: 'U' },
        { path: 'src/new-file.ts', indexStatus: 'A', workingTreeStatus: 'A' },
        {
          path: 'src/deleted-upstream.ts',
          indexStatus: 'D',
          workingTreeStatus: 'U'
        },
        {
          path: 'src/deleted-local.ts',
          indexStatus: 'U',
          workingTreeStatus: 'D'
        },
        { path: 'notes/todo.md', indexStatus: '?', workingTreeStatus: '?' }
      ]);
    });

    it('should parse copy-and-rename fixture output', () => {
      const output = readFileSync(
        new URL('./../fixtures/git-status/copy-rename.txt', import.meta.url),
        'utf8'
      );

      const parsed = manager.parseStatus(output);

      expect(parsed.currentBranch).toBe('main');
      expect(parsed.fileStatus).toEqual([
        { path: 'src/new-name.ts', indexStatus: 'R', workingTreeStatus: ' ' },
        {
          path: 'src/template-copy.ts',
          indexStatus: 'C',
          workingTreeStatus: ' '
        },
        { path: 'README.md', indexStatus: ' ', workingTreeStatus: 'M' }
      ]);
    });
  });

  describe('validateBranchName', () => {
    it('should validate non-empty branch names', () => {
      expect(manager.validateBranchName('main').isValid).toBe(true);
      expect(manager.validateBranchName('feature/new-feature').isValid).toBe(
        true
      );
    });

    it('should reject empty or whitespace-only branch names', () => {
      const emptyResult = manager.validateBranchName('');
      expect(emptyResult.isValid).toBe(false);
      expect(emptyResult.error).toBe('Branch name cannot be empty');

      const whitespaceResult = manager.validateBranchName('   ');
      expect(whitespaceResult.isValid).toBe(false);
      expect(whitespaceResult.error).toBe('Branch name cannot be empty');
    });

    it('should reject branch names starting with a hyphen', () => {
      const result = manager.validateBranchName('-malicious');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Branch name cannot start with a hyphen');

      const doubleHyphen = manager.validateBranchName('--delete');
      expect(doubleHyphen.isValid).toBe(false);
      expect(doubleHyphen.error).toBe('Branch name cannot start with a hyphen');
    });
  });

  describe('determineErrorCode', () => {
    it('should return GIT_OPERATION_FAILED for exit code 128 with not a git repository message', () => {
      const error = new Error('fatal: not a git repository');

      expect(manager.determineErrorCode('getCurrentBranch', error, 128)).toBe(
        ErrorCode.GIT_OPERATION_FAILED
      );
    });

    it('should return GIT_REPOSITORY_NOT_FOUND for exit code 128 with repository not found message', () => {
      const error = new Error('fatal: repository not found');

      expect(manager.determineErrorCode('clone', error, 128)).toBe(
        ErrorCode.GIT_REPOSITORY_NOT_FOUND
      );
    });

    it('should return GIT_AUTH_FAILED for permission errors', () => {
      expect(
        manager.determineErrorCode('clone', new Error('Permission denied'))
      ).toBe(ErrorCode.GIT_AUTH_FAILED);
    });

    it('should return GIT_REPOSITORY_NOT_FOUND for not found errors', () => {
      expect(
        manager.determineErrorCode('checkout', new Error('Branch not found'))
      ).toBe(ErrorCode.GIT_REPOSITORY_NOT_FOUND);
    });

    it('should return GIT_BRANCH_NOT_FOUND for pathspec errors', () => {
      expect(
        manager.determineErrorCode(
          'checkout',
          new Error("pathspec 'branch' did not match")
        )
      ).toBe(ErrorCode.GIT_BRANCH_NOT_FOUND);
    });

    it('should return GIT_AUTH_FAILED for authentication errors', () => {
      expect(
        manager.determineErrorCode('clone', new Error('Authentication failed'))
      ).toBe(ErrorCode.GIT_AUTH_FAILED);
    });

    it('should return operation-specific error codes as fallback', () => {
      expect(
        manager.determineErrorCode('clone', new Error('Unknown error'))
      ).toBe(ErrorCode.GIT_CLONE_FAILED);
      expect(
        manager.determineErrorCode('checkout', new Error('Unknown error'))
      ).toBe(ErrorCode.GIT_CHECKOUT_FAILED);
      expect(
        manager.determineErrorCode(
          'getCurrentBranch',
          new Error('Unknown error')
        )
      ).toBe(ErrorCode.GIT_OPERATION_FAILED);
      expect(
        manager.determineErrorCode('listBranches', new Error('Unknown error'))
      ).toBe(ErrorCode.GIT_OPERATION_FAILED);
    });

    it('should handle string errors', () => {
      expect(manager.determineErrorCode('clone', 'repository not found')).toBe(
        ErrorCode.GIT_REPOSITORY_NOT_FOUND
      );
    });

    it('should handle case-insensitive error matching', () => {
      expect(
        manager.determineErrorCode('clone', new Error('PERMISSION DENIED'))
      ).toBe(ErrorCode.GIT_AUTH_FAILED);
    });
  });

  describe('createErrorMessage', () => {
    it('should create error messages with operation context', () => {
      const cloneMsg = manager.createErrorMessage(
        'clone',
        { repoUrl: 'https://github.com/user/repo.git', targetDir: '/tmp/repo' },
        'Repository not found'
      );
      expect(cloneMsg).toContain('clone repository');
      expect(cloneMsg).toContain('repoUrl=https://github.com/user/repo.git');
      expect(cloneMsg).toContain('Repository not found');

      const checkoutMsg = manager.createErrorMessage(
        'checkout',
        { repoPath: '/tmp/repo', branch: 'develop' },
        'Branch not found'
      );
      expect(checkoutMsg).toContain('checkout branch');
      expect(checkoutMsg).toContain('branch=develop');
    });
  });

  describe('isSshUrl', () => {
    it('should return true for SSH URLs', () => {
      expect(manager.isSshUrl('git@github.com:user/repo.git')).toBe(true);
      expect(manager.isSshUrl('ssh://git@github.com:22/user/repo.git')).toBe(
        true
      );
    });

    it('should return false for HTTPS URLs', () => {
      expect(manager.isSshUrl('https://github.com/user/repo.git')).toBe(false);
    });

    it('should return false for file:// URLs', () => {
      expect(manager.isSshUrl('file:///path/to/repo')).toBe(false);
    });
  });

  describe('isHttpsUrl', () => {
    it('should return true for HTTPS URLs', () => {
      expect(manager.isHttpsUrl('https://github.com/user/repo.git')).toBe(true);
    });

    it('should return false for SSH URLs', () => {
      expect(manager.isHttpsUrl('git@github.com:user/repo.git')).toBe(false);
    });

    it('should return false for invalid URLs', () => {
      expect(manager.isHttpsUrl('not-a-url')).toBe(false);
    });
  });
});
