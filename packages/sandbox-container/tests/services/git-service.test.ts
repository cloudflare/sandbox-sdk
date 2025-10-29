import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  CloneOptions,
  Logger,
  ServiceResult
} from '@sandbox-container/core/types';
import {
  GitService,
  type SecurityService
} from '@sandbox-container/services/git-service';
import type {
  RawExecResult,
  SessionManager
} from '@sandbox-container/services/session-manager';
import { mocked } from '../test-utils';

// Properly typed mock dependencies
const mockSecurityService: SecurityService = {
  validateGitUrl: vi.fn(),
  validatePath: vi.fn(),
  sanitizePath: vi.fn()
};

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn()
};

// Properly typed mock SessionManager
const mockSessionManager: Partial<SessionManager> = {
  executeInSession: vi.fn(),
  executeStreamInSession: vi.fn(),
  killCommand: vi.fn(),
  setEnvVars: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn()
};

describe('GitService', () => {
  let gitService: GitService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Set up default successful security validations
    mocked(mockSecurityService.validateGitUrl).mockReturnValue({
      isValid: true,
      errors: []
    });
    mocked(mockSecurityService.validatePath).mockReturnValue({
      isValid: true,
      errors: []
    });

    gitService = new GitService(
      mockSecurityService,
      mockLogger,
      mockSessionManager as SessionManager
    );
  });

  describe('cloneRepository', () => {
    it('should clone repository successfully with default options', async () => {
      // Mock successful git clone
      mocked(mockSessionManager.executeInSession)
        .mockResolvedValueOnce({
          success: true,
          data: {
            exitCode: 0,
            stdout: 'Cloning into target-dir...',
            stderr: ''
          }
        } as ServiceResult<RawExecResult>)
        .mockResolvedValueOnce({
          success: true,
          data: {
            exitCode: 0,
            stdout: 'main\n',
            stderr: ''
          }
        } as ServiceResult<RawExecResult>);

      const result = await gitService.cloneRepository(
        'https://github.com/user/repo.git'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.path).toBe('/workspace/repo');
        expect(result.data.branch).toBe('main');
      }

      // Verify security validations were called
      expect(mockSecurityService.validateGitUrl).toHaveBeenCalledWith(
        'https://github.com/user/repo.git'
      );
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith(
        '/workspace/repo'
      );

      // Verify SessionManager was called for git clone (cwd is undefined)
      expect(mockSessionManager.executeInSession).toHaveBeenNthCalledWith(
        1,
        'default',
        'git clone https://github.com/user/repo.git /workspace/repo'
      );

      // Verify SessionManager was called for getting current branch
      expect(mockSessionManager.executeInSession).toHaveBeenNthCalledWith(
        2,
        'default',
        'git branch --show-current',
        '/workspace/repo'
      );
    });

    it('should clone repository with custom branch and target directory', async () => {
      mocked(mockSessionManager.executeInSession)
        .mockResolvedValueOnce({
          success: true,
          data: {
            exitCode: 0,
            stdout: 'Cloning...',
            stderr: ''
          }
        } as ServiceResult<RawExecResult>)
        .mockResolvedValueOnce({
          success: true,
          data: {
            exitCode: 0,
            stdout: 'develop\n',
            stderr: ''
          }
        } as ServiceResult<RawExecResult>);

      const options: CloneOptions = {
        branch: 'develop',
        targetDir: '/tmp/custom-target',
        sessionId: 'session-123'
      };

      const result = await gitService.cloneRepository(
        'https://github.com/user/repo.git',
        options
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.path).toBe('/tmp/custom-target');
        expect(result.data.branch).toBe('develop');
      }

      // Verify git clone command includes branch option (cwd is undefined)
      expect(mockSessionManager.executeInSession).toHaveBeenNthCalledWith(
        1,
        'session-123',
        'git clone --branch develop https://github.com/user/repo.git /tmp/custom-target'
      );
    });

    it('should return error when git URL validation fails', async () => {
      mocked(mockSecurityService.validateGitUrl).mockReturnValue({
        isValid: false,
        errors: ['Invalid URL scheme', 'URL not in allowlist']
      });

      const result = await gitService.cloneRepository(
        'ftp://malicious.com/repo.git'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_GIT_URL');
        expect(result.error.message).toContain('Invalid URL scheme');
        expect(result.error.details?.validationErrors).toBeDefined();
        expect(result.error.details?.validationErrors?.[0]?.message).toContain(
          'Invalid URL scheme'
        );
      }

      // Should not attempt git clone
      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should return error when target directory validation fails', async () => {
      mocked(mockSecurityService.validatePath).mockReturnValue({
        isValid: false,
        errors: ['Path outside sandbox', 'Path contains invalid characters']
      });

      const result = await gitService.cloneRepository(
        'https://github.com/user/repo.git',
        { targetDir: '/malicious/../path' }
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.details?.validationErrors).toBeDefined();
        expect(result.error.details?.validationErrors?.[0]?.message).toContain(
          'Path outside sandbox'
        );
      }

      // Should not attempt git clone
      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should return error when git clone command fails', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: repository not found'
        }
      } as ServiceResult<RawExecResult>);

      const result = await gitService.cloneRepository(
        'https://github.com/user/nonexistent.git'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('REPO_NOT_FOUND');
        expect(result.error.details?.exitCode).toBe(128);
        expect(result.error.details?.stderr).toContain('repository not found');
      }
    });

    it('should handle execution errors gracefully', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: false,
        error: {
          message: 'Session execution failed',
          code: 'SESSION_ERROR'
        }
      } as ServiceResult<RawExecResult>);

      const result = await gitService.cloneRepository(
        'https://github.com/user/repo.git'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_ERROR');
      }
    });
  });

  describe('checkoutBranch', () => {
    it('should checkout branch successfully', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: 'Switched to branch develop',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await gitService.checkoutBranch(
        '/tmp/repo',
        'develop',
        'session-123'
      );

      expect(result.success).toBe(true);

      // Verify SessionManager was called with correct parameters
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        'git checkout develop',
        '/tmp/repo'
      );
    });

    it('should return error when branch name is empty', async () => {
      const result = await gitService.checkoutBranch('/tmp/repo', '');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain('Invalid branch name');
      }

      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should return error when git checkout fails', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 1,
          stdout: '',
          stderr: "error: pathspec 'nonexistent' did not match"
        }
      } as ServiceResult<RawExecResult>);

      const result = await gitService.checkoutBranch(
        '/tmp/repo',
        'nonexistent'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('GIT_INVALID_REF');
        expect(result.error.details?.stderr).toContain('did not match');
      }
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch successfully', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: 'main\n',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await gitService.getCurrentBranch(
        '/tmp/repo',
        'session-123'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('main');
      }

      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        'git branch --show-current',
        '/tmp/repo'
      );
    });
  });

  describe('listBranches', () => {
    it('should list branches successfully and parse output correctly', async () => {
      const branchOutput = `  develop
* main
  feature/auth
  remotes/origin/HEAD -> origin/main
  remotes/origin/develop
  remotes/origin/main
  remotes/origin/feature/auth`;

      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: branchOutput,
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await gitService.listBranches('/tmp/repo', 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([
          'develop',
          'main',
          'feature/auth',
          'HEAD -> origin/main'
        ]);

        // Should not include duplicates or HEAD references
        expect(result.data).not.toContain('HEAD');
        expect(result.data.filter((b) => b === 'main')).toHaveLength(1);
      }

      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        'git branch -a',
        '/tmp/repo'
      );
    });

    it('should return error when git branch command fails', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: not a git repository'
        }
      } as ServiceResult<RawExecResult>);

      const result = await gitService.listBranches('/tmp/not-a-repo');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_A_GIT_REPO');
        expect(result.error.details?.exitCode).toBe(128);
      }
    });
  });
});
