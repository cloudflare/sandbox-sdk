/**
 * Git Handler Tests
 * 
 * Tests the GitHandler class from the refactored container architecture.
 * Demonstrates testing handlers with git operations and repository management.
 */

import type { GitCheckoutResponse, HandlerErrorResponse, Logger, RequestContext, ValidatedRequestContext } from '@container/core/types';
import type { GitHandler } from '@container/handlers/git-handler';
import type { GitService } from '@container/services/git-service';

// Mock the dependencies - use partial mock to avoid private property issues
const mockGitService = {
  cloneRepository: vi.fn(),
  checkoutBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  listBranches: vi.fn(),
} as GitService;

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

// Mock request context
const mockContext: RequestContext = {
  requestId: 'req-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-456',
};

// Helper to create validated context
const createValidatedContext = <T>(data: T): ValidatedRequestContext<T> => ({
  ...mockContext,
  validatedData: data
});

describe('GitHandler', () => {
  let gitHandler: GitHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the GitHandler (dynamic import)
    const { GitHandler: GitHandlerClass } = await import('@container/handlers/git-handler');
    gitHandler = new GitHandlerClass(mockGitService, mockLogger);
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

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: mockGitResult
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as GitCheckoutResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.repoUrl).toBe('https://github.com/user/awesome-repo.git');
      expect(responseData.branch).toBe('develop');
      expect(responseData.targetDir).toBe('/tmp/my-project');
      expect(responseData.exitCode).toBe(0);
      expect(responseData.stdout).toBe('');
      expect(responseData.stderr).toBe('');

      // Verify service was called correctly
      expect(mockGitService.cloneRepository).toHaveBeenCalledWith(
        'https://github.com/user/awesome-repo.git',
        {
          branch: 'develop',
          targetDir: '/tmp/my-project',
          sessionId: 'session-456'
        }
      );

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cloning git repository',
        expect.objectContaining({
          requestId: 'req-123',
          repoUrl: 'https://github.com/user/awesome-repo.git',
          branch: 'develop',
          targetDir: '/tmp/my-project'
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Repository cloned successfully',
        expect.objectContaining({
          requestId: 'req-123',
          repoUrl: 'https://github.com/user/awesome-repo.git',
          targetDirectory: '/tmp/my-project',
          branch: 'develop'
        })
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

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: mockGitResult
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as GitCheckoutResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.repoUrl).toBe('https://github.com/user/simple-repo.git');
      expect(responseData.branch).toBe('main'); // Service returned branch
      expect(responseData.targetDir).toBe('/tmp/git-clone-simple-repo-1672531200-abc123'); // Generated path

      // Verify service was called with undefined optional parameters
      expect(mockGitService.cloneRepository).toHaveBeenCalledWith(
        'https://github.com/user/simple-repo.git',
        {
          branch: undefined,
          targetDir: undefined,
          sessionId: undefined
        }
      );
    });

    it('should handle git URL validation errors', async () => {
      const gitCheckoutData = {
        repoUrl: 'invalid-url-format',
        branch: 'main'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Git URL validation failed: Invalid URL scheme',
          code: 'INVALID_GIT_URL',
          details: { repoUrl: 'invalid-url-format', errors: ['Invalid URL scheme'] }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(400);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('INVALID_GIT_URL');
      expect(responseData.error).toContain('Invalid URL scheme');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Git repository clone failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          repoUrl: 'invalid-url-format',
          branch: 'main',
          errorCode: 'INVALID_GIT_URL'
        })
      );
    });

    it('should handle target directory validation errors', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git',
        targetDir: '/malicious/../path'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Target directory validation failed: Path outside sandbox',
          code: 'INVALID_TARGET_PATH',
          details: { targetDirectory: '/malicious/../path', errors: ['Path outside sandbox'] }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(400);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('INVALID_TARGET_PATH');
      expect(responseData.error).toContain('Path outside sandbox');
    });

    it('should handle git clone command failures', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/nonexistent-repo.git',
        branch: 'main'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Git clone operation failed',
          code: 'GIT_CLONE_FAILED',
          details: {
            repoUrl: 'https://github.com/user/nonexistent-repo.git',
            exitCode: 128,
            stderr: 'fatal: repository \'https://github.com/user/nonexistent-repo.git\' not found'
          }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(400);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('GIT_CLONE_FAILED');
      expect(responseData.details.exitCode).toBe(128);
      expect(responseData.details.stderr).toContain('repository');
      expect(responseData.details.stderr).toContain('not found');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Git repository clone failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          repoUrl: 'https://github.com/user/nonexistent-repo.git',
          errorCode: 'GIT_CLONE_FAILED'
        })
      );
    });

    it('should handle invalid branch names', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git',
        branch: 'nonexistent-branch'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Git clone operation failed',
          code: 'GIT_CLONE_FAILED',
          details: {
            repoUrl: 'https://github.com/user/repo.git',
            exitCode: 128,
            stderr: 'fatal: Remote branch nonexistent-branch not found in upstream origin'
          }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(400);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('GIT_CLONE_FAILED');
      expect(responseData.details.stderr).toContain('nonexistent-branch not found');
    });

    it('should handle service exceptions', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Failed to clone repository',
          code: 'GIT_CLONE_ERROR',
          details: { repoUrl: 'https://github.com/user/repo.git', originalError: 'Command not found' }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(400);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('GIT_CLONE_ERROR');
      expect(responseData.details.originalError).toBe('Command not found');
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid git endpoints', async () => {
      const request = new Request('http://localhost:3000/api/git/invalid-operation', {
        method: 'POST'
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid git endpoint');

      // Should not call any service methods
      expect(mockGitService.cloneRepository).not.toHaveBeenCalled();
    });

    it('should return 404 for root git path', async () => {
      const request = new Request('http://localhost:3000/api/git/', {
        method: 'POST'
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid git endpoint');
    });

    it('should return 404 for git endpoint without operation', async () => {
      const request = new Request('http://localhost:3000/api/git', {
        method: 'POST'
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid git endpoint');
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in successful responses', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/repo.git'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: { path: '/tmp/repo', branch: 'main' }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/git/invalid', {
        method: 'POST'
      });

      const response = await gitHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
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

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: { path: '/tmp/feature-work', branch: 'feature-branch' }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as GitCheckoutResponse;

      // Verify all expected fields are present
      const expectedFields = ['success', 'stdout', 'stderr', 'exitCode', 'repoUrl', 'branch', 'targetDir', 'timestamp'];
      for (const field of expectedFields) {
        expect(responseData).toHaveProperty(field);
      }

      // Verify field values
      expect(responseData.success).toBe(true);
      expect(responseData.stdout).toBe('');
      expect(responseData.stderr).toBe('');
      expect(responseData.exitCode).toBe(0);
      expect(responseData.timestamp).toBeDefined();
      expect(new Date(responseData.timestamp)).toBeInstanceOf(Date);
    });

    it('should have proper Content-Type header', async () => {
      const gitCheckoutData = { repoUrl: 'https://github.com/user/repo.git' };
      const validatedContext = createValidatedContext(gitCheckoutData);

      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: { path: '/tmp/repo', branch: 'main' }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      const response = await gitHandler.handle(request, validatedContext);

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('logging integration', () => {
    it('should log all git operations with appropriate context', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/test-repo.git',
        branch: 'develop',
        targetDir: '/tmp/test-workspace',
        sessionId: 'session-789'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: true,
        data: { path: '/tmp/test-workspace', branch: 'develop' }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      await gitHandler.handle(request, validatedContext);

      // Verify comprehensive logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cloning git repository',
        expect.objectContaining({
          requestId: 'req-123',
          repoUrl: 'https://github.com/user/test-repo.git',
          branch: 'develop',
          targetDir: '/tmp/test-workspace'
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Repository cloned successfully',
        expect.objectContaining({
          requestId: 'req-123',
          repoUrl: 'https://github.com/user/test-repo.git',
          targetDirectory: '/tmp/test-workspace',
          branch: 'develop'
        })
      );
    });

    it('should log errors with full context', async () => {
      const gitCheckoutData = {
        repoUrl: 'https://github.com/user/private-repo.git',
        branch: 'restricted'
      };

      const validatedContext = createValidatedContext(gitCheckoutData);
      (mockGitService.cloneRepository as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Permission denied',
          code: 'GIT_PERMISSION_DENIED',
          details: { repoUrl: 'https://github.com/user/private-repo.git' }
        }
      });

      const request = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitCheckoutData)
      });

      await gitHandler.handle(request, validatedContext);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Git repository clone failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          repoUrl: 'https://github.com/user/private-repo.git',
          branch: 'restricted',
          targetDir: undefined,
          errorCode: 'GIT_PERMISSION_DENIED',
          errorMessage: 'Permission denied'
        })
      );
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored GitHandler:
 * 
 * 1. **Single Operation Focus**: GitHandler currently only implements git clone
 *    functionality, making it simpler but still comprehensive to test.
 * 
 * 2. **Parameter Flexibility**: Tests cover both full parameter sets and minimal
 *    required parameters, validating default handling.
 * 
 * 3. **ServiceResult Integration**: Handler converts GitService ServiceResult
 *    objects into appropriate HTTP responses with consistent formatting.
 * 
 * 4. **Git-Specific Error Scenarios**: Tests cover various git-specific failures
 *    including URL validation, path validation, repository not found, invalid
 *    branches, and command execution failures.
 * 
 * 5. **Response Format Consistency**: Tests ensure the response format matches
 *    expectations with proper fields (success, stdout, stderr, exitCode, etc.).
 * 
 * 6. **Logging Integration**: Comprehensive logging tests for both successful
 *    operations and error scenarios with full context.
 * 
 * 7. **Route Validation**: Tests ensure only valid git endpoints are handled
 *    and invalid requests return appropriate 404 responses.
 * 
 * 8. **CORS Headers**: Tests validate CORS headers are included in both
 *    success and error responses.
 * 
 * 9. **Error Details Preservation**: Tests ensure that detailed error information
 *    from git commands (exit codes, stderr output) is properly preserved.
 * 
 * 10. **Content Type Validation**: Tests ensure proper JSON response headers
 *     are set for all responses.
 */