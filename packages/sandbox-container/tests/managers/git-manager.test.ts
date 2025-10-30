import { beforeEach, describe, expect, it } from 'bun:test';
import { GitManager } from '@sandbox-container/managers/git-manager.ts';

describe('GitManager', () => {
  let manager: GitManager;

  beforeEach(() => {
    manager = new GitManager();
  });

  describe('extractRepoName', () => {
    it('should extract repo name from various URL formats', () => {
      expect(manager.extractRepoName('https://github.com/user/repo.git')).toBe(
        'repo'
      );
      expect(manager.extractRepoName('https://github.com/user/my-repo')).toBe(
        'my-repo'
      );
      expect(manager.extractRepoName('git@github.com:user/repo.git')).toBe(
        'repo'
      );
      expect(
        manager.extractRepoName('https://github.com/user/my-awesome_repo.git')
      ).toBe('my-awesome_repo');
    });

    it('should return fallback for invalid URLs', () => {
      expect(manager.extractRepoName('not-a-valid-url')).toBe('repository');
      expect(manager.extractRepoName('')).toBe('repository');
    });
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
        '--branch',
        'develop',
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
      expect(branches).toContain('HEAD -> origin/main');
    });

    it('should handle empty and single branch lists', () => {
      expect(manager.parseBranchList('\n\n  \n')).toEqual([]);
      expect(manager.parseBranchList('* main')).toEqual(['main']);
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
  });

  describe('determineErrorCode', () => {
    it('should return NOT_A_GIT_REPO for exit code 128 with not a git repository message', () => {
      const error = new Error('fatal: not a git repository');

      expect(manager.determineErrorCode('getCurrentBranch', error, 128)).toBe(
        'NOT_A_GIT_REPO'
      );
    });

    it('should return REPO_NOT_FOUND for exit code 128 with repository not found message', () => {
      const error = new Error('fatal: repository not found');

      expect(manager.determineErrorCode('clone', error, 128)).toBe(
        'REPO_NOT_FOUND'
      );
    });

    it('should return GIT_PERMISSION_DENIED for permission errors', () => {
      expect(
        manager.determineErrorCode('clone', new Error('Permission denied'))
      ).toBe('GIT_PERMISSION_DENIED');
    });

    it('should return GIT_NOT_FOUND for not found errors', () => {
      expect(
        manager.determineErrorCode('checkout', new Error('Branch not found'))
      ).toBe('GIT_NOT_FOUND');
    });

    it('should return GIT_INVALID_REF for pathspec errors', () => {
      expect(
        manager.determineErrorCode(
          'checkout',
          new Error("pathspec 'branch' did not match")
        )
      ).toBe('GIT_INVALID_REF');
    });

    it('should return GIT_AUTH_FAILED for authentication errors', () => {
      expect(
        manager.determineErrorCode('clone', new Error('Authentication failed'))
      ).toBe('GIT_AUTH_FAILED');
    });

    it('should return operation-specific error codes as fallback', () => {
      expect(
        manager.determineErrorCode('clone', new Error('Unknown error'))
      ).toBe('GIT_CLONE_FAILED');
      expect(
        manager.determineErrorCode('checkout', new Error('Unknown error'))
      ).toBe('GIT_CHECKOUT_FAILED');
      expect(
        manager.determineErrorCode(
          'getCurrentBranch',
          new Error('Unknown error')
        )
      ).toBe('GIT_BRANCH_ERROR');
      expect(
        manager.determineErrorCode('listBranches', new Error('Unknown error'))
      ).toBe('GIT_BRANCH_LIST_ERROR');
    });

    it('should handle string errors', () => {
      expect(manager.determineErrorCode('clone', 'repository not found')).toBe(
        'GIT_NOT_FOUND'
      );
    });

    it('should handle case-insensitive error matching', () => {
      expect(
        manager.determineErrorCode('clone', new Error('PERMISSION DENIED'))
      ).toBe('GIT_PERMISSION_DENIED');
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
