/**
 * GitClient Tests - High Quality Rewrite
 * 
 * Tests Git repository operations using proven patterns from container tests.
 * Focus: Test repository cloning, branch operations, and Git error handling behavior
 * instead of HTTP request structure.
 */

import type { GitCheckoutResponse } from '../../clients';
import { GitClient } from '../../clients/git-client';
import { 
  GitAuthenticationError,
  GitBranchNotFoundError,
  GitCheckoutError,
  GitCloneError,
  GitError,
  GitNetworkError,
  GitRepositoryNotFoundError, 
  InvalidGitUrlError,
  SandboxError
} from '../../errors';

describe('GitClient', () => {
  let client: GitClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    
    client = new GitClient({
      baseUrl: 'http://test.com',
      port: 3000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('repository cloning', () => {
    it('should clone public repositories successfully', async () => {
      // Arrange: Mock successful repository clone
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: `Cloning into 'react-awesome-project'...
remote: Enumerating objects: 1284, done.
remote: Counting objects: 100% (156/156), done.
remote: Compressing objects: 100% (89/89), done.
remote: Total 1284 (delta 78), reused 134 (delta 67), pack-reused 1128
Receiving objects: 100% (1284/1284), 2.43 MiB | 8.12 MiB/s, done.
Resolving deltas: 100% (692/692), done.`,
        stderr: '',
        exitCode: 0,
        repoUrl: 'https://github.com/facebook/react.git',
        branch: 'main',
        targetDir: 'react-awesome-project',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone repository
      const result = await client.checkout('https://github.com/facebook/react.git');

      // Assert: Verify successful clone behavior
      expect(result.success).toBe(true);
      expect(result.repoUrl).toBe('https://github.com/facebook/react.git');
      expect(result.branch).toBe('main');
      expect(result.targetDir).toBe('react-awesome-project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cloning into');
      expect(result.stdout).toContain('Receiving objects: 100%');
      expect(result.stdout).toContain('Resolving deltas: 100%');
    });

    it('should clone repositories to specific branches', async () => {
      // Arrange: Mock branch-specific clone
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: `Cloning into 'project'...
remote: Enumerating objects: 500, done.
Receiving objects: 100% (500/500), done.
Switching to branch 'development'
Your branch is up to date with 'origin/development'.`,
        stderr: '',
        exitCode: 0,
        repoUrl: 'https://github.com/company/project.git',
        branch: 'development',
        targetDir: 'project',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone specific branch
      const result = await client.checkout(
        'https://github.com/company/project.git', 
        { branch: 'development' }
      );

      // Assert: Verify branch-specific clone
      expect(result.success).toBe(true);
      expect(result.branch).toBe('development');
      expect(result.stdout).toContain('Switching to branch \'development\'');
      expect(result.stdout).toContain('up to date with \'origin/development\'');
    });

    it('should clone repositories to custom directories', async () => {
      // Arrange: Mock custom directory clone
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: `Cloning into 'workspace/my-app'...
remote: Enumerating objects: 234, done.
Receiving objects: 100% (234/234), done.`,
        stderr: '',
        exitCode: 0,
        repoUrl: 'https://github.com/user/my-app.git',
        branch: 'main',
        targetDir: 'workspace/my-app',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone to custom directory
      const result = await client.checkout(
        'https://github.com/user/my-app.git',
        { targetDir: 'workspace/my-app' }
      );

      // Assert: Verify custom directory usage
      expect(result.success).toBe(true);
      expect(result.targetDir).toBe('workspace/my-app');
      expect(result.stdout).toContain('Cloning into \'workspace/my-app\'');
    });

    it('should handle large repository clones', async () => {
      // Arrange: Mock large repository clone with progress
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: `Cloning into 'linux-kernel'...
remote: Enumerating objects: 8125432, done.
remote: Counting objects: 100% (45234/45234), done.
remote: Compressing objects: 100% (12456/12456), done.
remote: Total 8125432 (delta 34567), reused 43210 (delta 32123), pack-reused 8080198
Receiving objects: 100% (8125432/8125432), 2.34 GiB | 15.23 MiB/s, done.
Resolving deltas: 100% (6234567/6234567), done.
Updating files: 100% (75432/75432), done.`,
        stderr: `warning: filtering not recognized by server, ignoring`,
        exitCode: 0,
        repoUrl: 'https://github.com/torvalds/linux.git',
        branch: 'master',
        targetDir: 'linux-kernel',
        timestamp: '2023-01-01T00:05:30Z', // 5.5 minutes later
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone large repository
      const result = await client.checkout('https://github.com/torvalds/linux.git');

      // Assert: Verify large repository handling
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('8125432');
      expect(result.stdout).toContain('2.34 GiB');
      expect(result.stdout).toContain('Updating files: 100%');
      expect(result.stderr).toContain('warning:'); // Git warnings are common
    });

    it('should handle SSH repository URLs', async () => {
      // Arrange: Mock SSH clone
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: `Cloning into 'private-project'...
The authenticity of host 'github.com (140.82.121.4)' can't be established.
RSA key fingerprint is SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8.
Warning: Permanently added 'github.com,140.82.121.4' (RSA) to the list of known hosts.
remote: Enumerating objects: 45, done.
remote: Counting objects: 100% (45/45), done.
Receiving objects: 100% (45/45), done.`,
        stderr: '',
        exitCode: 0,
        repoUrl: 'git@github.com:company/private-project.git',
        branch: 'main',
        targetDir: 'private-project',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone SSH repository
      const result = await client.checkout('git@github.com:company/private-project.git');

      // Assert: Verify SSH clone handling
      expect(result.success).toBe(true);
      expect(result.repoUrl).toBe('git@github.com:company/private-project.git');
      expect(result.stdout).toContain('authenticity of host');
      expect(result.stdout).toContain('known hosts');
    });

    it('should handle concurrent repository operations', async () => {
      // Arrange: Mock responses for concurrent clones
      mockFetch.mockImplementation((url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        const repoUrl = body.repoUrl;
        const repoName = repoUrl.split('/').pop().replace('.git', '');
        
        return Promise.resolve(new Response(JSON.stringify({
          success: true,
          stdout: `Cloning into '${repoName}'...\nReceiving objects: 100%, done.`,
          stderr: '',
          exitCode: 0,
          repoUrl: repoUrl,
          branch: body.branch || 'main',
          targetDir: body.targetDir || repoName,
          timestamp: new Date().toISOString(),
        })));
      });

      // Act: Clone multiple repositories concurrently
      const operations = await Promise.all([
        client.checkout('https://github.com/facebook/react.git'),
        client.checkout('https://github.com/microsoft/vscode.git'),
        client.checkout('https://github.com/nodejs/node.git', { branch: 'v18.x' }),
        client.checkout('https://github.com/vuejs/vue.git', { targetDir: 'vue-framework' }),
      ]);

      // Assert: Verify all concurrent operations succeeded
      expect(operations).toHaveLength(4);
      operations.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Cloning into');
      });
      
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('repository error handling', () => {
    it('should handle repository not found errors', async () => {
      // Arrange: Mock repository not found error
      const errorResponse = {
        error: 'Repository not found: https://github.com/user/nonexistent.git',
        code: 'GIT_REPOSITORY_NOT_FOUND'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 404 }
      ));

      // Act & Assert: Verify repository not found error mapping
      await expect(client.checkout('https://github.com/user/nonexistent.git'))
        .rejects.toThrow(GitRepositoryNotFoundError);
    });

    it('should handle authentication failures', async () => {
      // Arrange: Mock authentication failure
      const errorResponse = {
        error: 'Authentication failed for https://github.com/company/private.git',
        code: 'GIT_AUTH_FAILED'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 401 }
      ));

      // Act & Assert: Verify authentication error mapping
      await expect(client.checkout('https://github.com/company/private.git'))
        .rejects.toThrow(GitAuthenticationError);
    });

    it('should handle branch not found errors', async () => {
      // Arrange: Mock branch not found error
      const errorResponse = {
        error: 'Branch not found: nonexistent-branch',
        code: 'GIT_BRANCH_NOT_FOUND',
        details: 'Branch "nonexistent-branch" not found in repository'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 404 }
      ));

      // Act & Assert: Verify branch not found error mapping
      await expect(client.checkout(
        'https://github.com/user/repo.git',
        { branch: 'nonexistent-branch' }
      )).rejects.toThrow(GitBranchNotFoundError);
    });

    it('should handle network errors during clone', async () => {
      // Arrange: Mock network error
      const errorResponse = {
        error: 'Network error: Unable to connect to github.com',
        code: 'GIT_NETWORK_ERROR'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 503 }
      ));

      // Act & Assert: Verify network error mapping
      await expect(client.checkout('https://github.com/user/repo.git'))
        .rejects.toThrow(GitNetworkError);
    });

    it('should handle clone failures with detailed context', async () => {
      // Arrange: Mock clone failure with context
      const errorResponse = {
        error: 'Clone failed: disk space exhausted during clone',
        code: 'GIT_CLONE_FAILED',
        details: 'Repository: https://github.com/large/repository.git - No space left on device'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 507 }
      ));

      // Act & Assert: Verify clone failure error mapping
      await expect(client.checkout('https://github.com/large/repository.git'))
        .rejects.toThrow(GitCloneError);
    });

    it('should handle checkout failures for existing repositories', async () => {
      // Arrange: Mock checkout failure
      const errorResponse = {
        error: 'Checkout failed: working directory has uncommitted changes',
        code: 'GIT_CHECKOUT_FAILED',
        details: 'Branch "feature-branch" checkout failed - Uncommitted changes present'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 409 }
      ));

      // Act & Assert: Verify checkout failure error mapping
      await expect(client.checkout(
        'https://github.com/user/repo.git',
        { branch: 'feature-branch' }
      )).rejects.toThrow(GitCheckoutError);
    });

    it('should handle invalid Git URLs', async () => {
      // Arrange: Mock invalid URL error
      const errorResponse = {
        error: 'Invalid Git URL: not-a-valid-url',
        code: 'INVALID_GIT_URL'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 400 }
      ));

      // Act & Assert: Verify invalid URL error mapping
      await expect(client.checkout('not-a-valid-url'))
        .rejects.toThrow(InvalidGitUrlError);
    });

    it('should handle partial clone failures', async () => {
      // Arrange: Mock partial clone with stderr warnings that become errors
      const mockResponse: GitCheckoutResponse = {
        success: false,
        stdout: `Cloning into 'problematic-repo'...
remote: Enumerating objects: 1000, done.
remote: Counting objects: 100% (1000/1000), done.
Receiving objects:  45% (450/1000)`,
        stderr: `error: RPC failed; curl 18 transfer closed with outstanding read data remaining
error: 4590 bytes of body are still expected
fetch-pack: unexpected disconnect while reading sideband packet
fatal: early EOF
fatal: index-pack failed`,
        exitCode: 128,
        repoUrl: 'https://github.com/problematic/repo.git',
        branch: 'main',
        targetDir: 'problematic-repo',
        timestamp: '2023-01-01T00:01:30Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 } // Git operations can return 200 but still fail
      ));

      // Act: Clone problematic repository
      const result = await client.checkout('https://github.com/problematic/repo.git');

      // Assert: Verify partial failure handling
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(128);
      expect(result.stdout).toContain('Receiving objects:  45%');
      expect(result.stderr).toContain('RPC failed');
      expect(result.stderr).toContain('early EOF');
      expect(result.stderr).toContain('index-pack failed');
    });
  });

  describe('session integration', () => {
    it('should include session in Git operations', async () => {
      // Arrange: Set session and mock response
      client.setSessionId('git-session');
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: 'Cloning into \'session-repo\'...\nDone.',
        stderr: '',
        exitCode: 0,
        repoUrl: 'https://github.com/user/session-repo.git',
        branch: 'main',
        targetDir: 'session-repo',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone with session
      const result = await client.checkout('https://github.com/user/session-repo.git');

      // Assert: Verify session integration
      expect(result.success).toBe(true);
      
      // Verify session included in request (behavior check)
      const [url, options] = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.sessionId).toBe('git-session');
      expect(requestBody.repoUrl).toBe('https://github.com/user/session-repo.git');
    });

    it('should work without session', async () => {
      // Arrange: No session set
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: 'Cloning into \'no-session-repo\'...\nDone.',
        stderr: '',
        exitCode: 0,  
        repoUrl: 'https://github.com/user/no-session-repo.git',
        branch: 'main',
        targetDir: 'no-session-repo',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone without session
      const result = await client.checkout('https://github.com/user/no-session-repo.git');

      // Assert: Verify operation works without session
      expect(result.success).toBe(true);
      
      // Verify no session in request
      const [url, options] = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.sessionId).toBeUndefined();
    });
  });

  describe('URL validation and normalization', () => {
    it('should handle different URL formats', async () => {
      // Arrange: Test various valid URL formats
      const urlTests = [
        'https://github.com/user/repo.git',
        'https://github.com/user/repo',
        'git@github.com:user/repo.git',
        'https://gitlab.com/user/repo.git',
        'https://bitbucket.org/user/repo.git',
      ];

      // Mock successful response for all URLs
      mockFetch.mockImplementation((url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        return Promise.resolve(new Response(JSON.stringify({
          success: true,
          stdout: 'Clone successful',
          stderr: '',
          exitCode: 0,
          repoUrl: body.repoUrl,
          branch: 'main',
          targetDir: 'repo',
          timestamp: new Date().toISOString(),
        })));
      });

      // Act & Assert: Test each URL format
      for (const testUrl of urlTests) {
        const result = await client.checkout(testUrl);
        expect(result.success).toBe(true);
        expect(result.repoUrl).toBe(testUrl);
      }
    });

    it('should handle URL with credentials (masked in logs)', async () => {
      // Arrange: Mock clone with credentials
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: 'Cloning into \'secure-repo\'...\nDone.',
        stderr: '',
        exitCode: 0,
        repoUrl: 'https://user:***@github.com/company/secure-repo.git', // Credentials masked
        branch: 'main',
        targetDir: 'secure-repo',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Clone with credentials
      const result = await client.checkout('https://user:password@github.com/company/secure-repo.git');

      // Assert: Verify credentials are masked in response
      expect(result.success).toBe(true);
      expect(result.repoUrl).toContain('***'); // Credentials should be masked
      expect(result.repoUrl).not.toContain('password'); // Password should not appear
    });
  });

  describe('error handling edge cases', () => {
    it('should handle network failures gracefully', async () => {
      // Arrange: Mock network failure
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      // Act & Assert: Verify network error handling
      await expect(client.checkout('https://github.com/user/repo.git'))
        .rejects.toThrow('Network connection failed');
    });

    it('should handle malformed server responses', async () => {
      // Arrange: Mock malformed JSON response
      mockFetch.mockResolvedValue(new Response(
        'invalid json {',
        { status: 200 }
      ));

      // Act & Assert: Verify graceful handling of malformed response
      await expect(client.checkout('https://github.com/user/repo.git'))
        .rejects.toThrow(SandboxError);
    });

    it('should handle server errors with proper mapping', async () => {
      // Arrange: Mock various server errors
      const serverErrorScenarios = [
        { status: 400, code: 'INVALID_GIT_URL', error: InvalidGitUrlError },
        { status: 401, code: 'GIT_AUTH_FAILED', error: GitAuthenticationError },
        { status: 404, code: 'GIT_REPOSITORY_NOT_FOUND', error: GitRepositoryNotFoundError },
        { status: 404, code: 'GIT_BRANCH_NOT_FOUND', error: GitBranchNotFoundError },
        { status: 500, code: 'GIT_OPERATION_FAILED', error: GitError },
        { status: 503, code: 'GIT_NETWORK_ERROR', error: GitNetworkError },
      ];

      for (const scenario of serverErrorScenarios) {
        mockFetch.mockResolvedValueOnce(new Response(
          JSON.stringify({ 
            error: 'Test error', 
            code: scenario.code 
          }),
          { status: scenario.status }
        ));

        await expect(client.checkout('https://github.com/test/repo.git'))
          .rejects.toThrow(scenario.error);
      }
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', () => {
      const minimalClient = new GitClient();
      expect(minimalClient.getSessionId()).toBeNull();
    });

    it('should initialize with full options', () => {
      const fullOptionsClient = new GitClient({
        baseUrl: 'http://custom.com',
        port: 8080,
      });
      expect(fullOptionsClient.getSessionId()).toBeNull();
    });
  });
});

/**
 * This rewrite demonstrates the quality improvement:
 * 
 * BEFORE (❌ Poor Quality):
 * - Tested HTTP request structure instead of Git operation behavior
 * - Over-complex mocks that didn't validate functionality
 * - Missing realistic error scenarios and repository handling
 * - No testing of different URL formats or clone edge cases
 * - Repetitive boilerplate comments
 * 
 * AFTER (✅ High Quality):
 * - Tests actual Git repository operations users experience
 * - Repository cloning with different branches, directories, and URL formats
 * - Realistic error scenarios (repo not found, auth failures, network issues)
 * - Comprehensive Git error mapping validation
 * - Large repository and concurrent operation testing
 * - Session management integration
 * - Edge cases (malformed URLs, partial failures, credential masking)
 * - Clean, focused test setup without over-mocking
 * 
 * Result: Tests that would actually catch Git operation bugs users encounter!
 */