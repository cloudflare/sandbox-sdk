import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { GitCheckoutResult, Logger } from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import type { RequestContext } from '@sandbox-container/core/types';
import { GitHandler } from '@sandbox-container/handlers/git-handler';
import type { GitService } from '@sandbox-container/services/git-service';

// Mock the dependencies - use partial mock to avoid private property issues
const mockGitService = {
  cloneRepository: vi.fn(),
  checkoutBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  listBranches: vi.fn()
} as unknown as GitService;

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

// Mock request context
const mockContext: RequestContext = {
  requestId: 'req-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  },
  sessionId: 'session-456'
};

describe('GitHandler', () => {
  let gitHandler: GitHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    gitHandler = new GitHandler(mockGitService, mockLogger);
  });

  describe('handleCheckout - POST /api/git/checkout', () => {
    it('should clone repository successfully with all options', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/awesome-repo.git',
        branch: 'develop',
        targetDir: '/tmp/my-project',
        sessionId: 'session-456'
      };

      const mockGitResult = {
        path: '/tmp/my-project',
        branch: 'develop'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: mockGitResult
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as GitCheckoutResult;
      expect(responseData.success).toBe(true);
      expect(responseData.repoUrl).toBe(
        'https://github.com/user/awesome-repo.git'
      );
      expect(responseData.targetDir).toBe('/tmp/my-project');
      expect(responseData.branch).toBe('develop');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockGitService.cloneRepository).toHaveBeenCalledWith(
        'https://github.com/user/awesome-repo.git',
        {
          branch: 'develop',
          targetDir: '/tmp/my-project',
          sessionId: 'session-456'
        }
      );
    });

    it('should clone repository with minimal options', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/simple-repo.git'
        // branch, targetDir, sessionId not provided
      };

      const mockGitResult = {
        path: '/tmp/git-clone-simple-repo-1672531200-abc123',
        branch: 'main'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: mockGitResult
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as GitCheckoutResult;
      expect(responseData.success).toBe(true);
      expect(responseData.repoUrl).toBe(
        'https://github.com/user/simple-repo.git'
      );
      expect(responseData.branch).toBe('main'); // Service returned branch
      expect(responseData.targetDir).toBe(
        '/tmp/git-clone-simple-repo-1672531200-abc123'
      ); // Generated path
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called with correct parameters
      expect(mockGitService.cloneRepository).toHaveBeenCalledWith(
        'https://github.com/user/simple-repo.git',
        {
          branch: undefined,
          targetDir: undefined,
          sessionId: 'session-456' // From mockContext
        }
      );
    });

    it('should handle git URL validation errors', async () => {
      const gitCheckoutData = {
        repoUrl: 'invalid-url-format',
        branch: 'main'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Git URL validation failed: Invalid URL scheme',
          code: 'INVALID_GIT_URL',
          details: {
            repoUrl: 'invalid-url-format',
            errors: ['Invalid URL scheme']
          }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('INVALID_GIT_URL');
      expect(responseData.message).toContain('Invalid URL scheme');
      expect(responseData.httpStatus).toBe(400);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle target directory validation errors', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git',
        targetDir: '/malicious/../path'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Target directory validation failed: Path outside sandbox',
          code: 'VALIDATION_FAILED',
          details: {
            targetDirectory: '/malicious/../path',
            errors: ['Path outside sandbox']
          }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('VALIDATION_FAILED');
      expect(responseData.message).toContain('Path outside sandbox');
      expect(responseData.httpStatus).toBe(400);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle git clone command failures', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/nonexistent-repo.git',
        branch: 'main'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Git clone operation failed',
          code: 'GIT_CLONE_FAILED',
          details: {
            repoUrl: 'https://github.com/user/nonexistent-repo.git',
            exitCode: 128,
            stderr:
              "fatal: repository 'https://github.com/user/nonexistent-repo.git' not found"
          }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('GIT_CLONE_FAILED');
      expect(responseData.context.exitCode).toBe(128);
      expect(responseData.context.stderr).toContain('repository');
      expect(responseData.context.stderr).toContain('not found');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle invalid branch names', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git',
        branch: 'nonexistent-branch'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Git clone operation failed',
          code: 'GIT_CLONE_FAILED',
          details: {
            repoUrl: 'https://github.com/user/repo.git',
            exitCode: 128,
            stderr:
              'fatal: Remote branch nonexistent-branch not found in upstream origin'
          }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('GIT_CLONE_FAILED');
      expect(responseData.context.stderr).toContain(
        'nonexistent-branch not found'
      );
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle service exceptions', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Failed to clone repository',
          code: 'GIT_OPERATION_FAILED',
          details: {
            repoUrl: 'https://github.com/user/repo.git',
            originalError: 'Command not found'
          }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('GIT_OPERATION_FAILED');
      expect(responseData.context.originalError).toBe('Command not found');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid git endpoints', async () => {
      const request = new Request(
        'http://localhost:3000/api/git/invalid-operation',
        {
          method: 'POST'
        }
      );

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.message).toBe('Invalid git endpoint');
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();

      // Should not call any service methods
      expect(mockGitService.cloneRepository).not.toHaveBeenCalled();
    });

    it('should return 500 for root git path', async () => {
      const request = new Request('http://localhost:3000/api/git/', {
        method: 'POST'
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.message).toBe('Invalid git endpoint');
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should return 500 for git endpoint without operation', async () => {
      const request = new Request('http://localhost:3000/api/git', {
        method: 'POST'
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.message).toBe('Invalid git endpoint');
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in successful responses', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: { path: '/tmp/repo', branch: 'main' }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type'
      );
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/git/invalid', {
        method: 'POST'
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('response format consistency', () => {
    it('should return consistent response format for successful clones', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git',
        branch: 'feature-branch',
        targetDir: '/tmp/feature-work'
      };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: { path: '/tmp/feature-work', branch: 'feature-branch' }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as GitCheckoutResult;

      // Verify all expected fields are present
      const expectedFields = [
        'success',
        'repoUrl',
        'branch',
        'targetDir',
        'timestamp'
      ];
      for (const field of expectedFields) {
        expect(responseData).toHaveProperty(field);
      }

      // Verify field values
      expect(responseData.success).toBe(true);
      expect(responseData.repoUrl).toBe('https://github.com/user/repo.git');
      expect(responseData.targetDir).toBe('/tmp/feature-work');
      expect(responseData.branch).toBe('feature-branch');
      expect(responseData.timestamp).toBeDefined();
      expect(new Date(responseData.timestamp)).toBeInstanceOf(Date);
    });

    it('should have proper Content-Type header', async () => {
      const gitCheckoutData = { repoUrl: 'https://github.com/user/repo.git' };

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: { path: '/tmp/repo', branch: 'main' }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });
  });
});
