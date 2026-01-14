import type { GitCheckoutResult } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../src/clients/git-client';
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
} from '../src/errors';

describe('GitClient', () => {
  let client: GitClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    client = new GitClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('repository cloning', () => {
    it('should clone public repositories successfully', async () => {
      const mockResponse: GitCheckoutResult = {
        success: true,
        repoUrl: 'https://github.com/facebook/react.git',
        branch: 'main',
        targetDir: 'react',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'https://github.com/facebook/react.git',
        'test-session'
      );

      expect(result.success).toBe(true);
      expect(result.repoUrl).toBe('https://github.com/facebook/react.git');
      expect(result.branch).toBe('main');
    });

    it('should clone repositories to specific branches', async () => {
      const mockResponse: GitCheckoutResult = {
        success: true,
        repoUrl: 'https://github.com/company/project.git',
        branch: 'development',
        targetDir: 'project',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'https://github.com/company/project.git',
        'test-session',
        { branch: 'development' }
      );

      expect(result.success).toBe(true);
      expect(result.branch).toBe('development');
    });

    it('should clone repositories to custom directories', async () => {
      const mockResponse: GitCheckoutResult = {
        success: true,
        repoUrl: 'https://github.com/user/my-app.git',
        branch: 'main',
        targetDir: 'workspace/my-app',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'https://github.com/user/my-app.git',
        'test-session',
        { targetDir: 'workspace/my-app' }
      );

      expect(result.success).toBe(true);
      expect(result.targetDir).toBe('workspace/my-app');
    });

    it('should handle large repository clones with warnings', async () => {
      const mockResponse: GitCheckoutResult = {
        success: true,
        repoUrl: 'https://github.com/torvalds/linux.git',
        branch: 'master',
        targetDir: 'linux',
        timestamp: '2023-01-01T00:05:30Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'https://github.com/torvalds/linux.git',
        'test-session'
      );

      expect(result.success).toBe(true);
    });

    it('should clone repositories with shallow depth option', async () => {
      const mockResponse: GitCheckoutResult = {
        success: true,
        repoUrl: 'https://github.com/torvalds/linux.git',
        branch: 'master',
        targetDir: '/workspace/linux',
        timestamp: '2023-01-01T00:00:30Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'https://github.com/torvalds/linux.git',
        'test-session',
        { depth: 1 }
      );

      expect(result.success).toBe(true);

      // Verify the request included depth
      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body as string);
      expect(requestBody.depth).toBe(1);
    });

    it('should clone repositories with branch and depth options combined', async () => {
      const mockResponse: GitCheckoutResult = {
        success: true,
        repoUrl: 'https://github.com/company/project.git',
        branch: 'develop',
        targetDir: '/workspace/project',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'https://github.com/company/project.git',
        'test-session',
        { branch: 'develop', depth: 10 }
      );

      expect(result.success).toBe(true);
      expect(result.branch).toBe('develop');

      // Verify the request included both branch and depth
      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body as string);
      expect(requestBody.branch).toBe('develop');
      expect(requestBody.depth).toBe(10);
    });

    it('should reject depth of zero', async () => {
      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session', {
          depth: 0
        })
      ).rejects.toThrow('Invalid depth value: 0');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject negative depth values', async () => {
      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session', {
          depth: -5
        })
      ).rejects.toThrow('Invalid depth value: -5');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject non-integer depth values', async () => {
      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session', {
          depth: 1.5
        })
      ).rejects.toThrow('Invalid depth value: 1.5');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle SSH repository URLs', async () => {
      const mockResponse: GitCheckoutResult = {
        success: true,
        repoUrl: 'git@github.com:company/private-project.git',
        branch: 'main',
        targetDir: 'private-project',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'git@github.com:company/private-project.git',
        'test-session'
      );

      expect(result.success).toBe(true);
      expect(result.repoUrl).toBe('git@github.com:company/private-project.git');
    });

    it('should handle concurrent repository operations', async () => {
      mockFetch.mockImplementation((url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        const repoName = body.repoUrl.split('/').pop().replace('.git', '');

        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              stdout: `Cloning into '${repoName}'...\nDone.`,
              repoUrl: body.repoUrl,
              branch: body.branch || 'main',
              targetDir: body.targetDir || repoName,
              timestamp: new Date().toISOString()
            })
          )
        );
      });

      const operations = await Promise.all([
        client.checkout('https://github.com/facebook/react.git', 'session-1'),
        client.checkout('https://github.com/microsoft/vscode.git', 'session-2'),
        client.checkout('https://github.com/nodejs/node.git', 'session-3', {
          branch: 'v18.x'
        })
      ]);

      expect(operations).toHaveLength(3);
      operations.forEach((result) => {
        expect(result.success).toBe(true);
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('repository error handling', () => {
    it('should handle repository not found errors', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Repository not found',
            code: 'GIT_REPOSITORY_NOT_FOUND'
          }),
          { status: 404 }
        )
      );

      await expect(
        client.checkout(
          'https://github.com/user/nonexistent.git',
          'test-session'
        )
      ).rejects.toThrow(GitRepositoryNotFoundError);
    });

    it('should handle authentication failures', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Authentication failed',
            code: 'GIT_AUTH_FAILED'
          }),
          { status: 401 }
        )
      );

      await expect(
        client.checkout(
          'https://github.com/company/private.git',
          'test-session'
        )
      ).rejects.toThrow(GitAuthenticationError);
    });

    it('should handle branch not found errors', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Branch not found',
            code: 'GIT_BRANCH_NOT_FOUND'
          }),
          { status: 404 }
        )
      );

      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session', {
          branch: 'nonexistent-branch'
        })
      ).rejects.toThrow(GitBranchNotFoundError);
    });

    it('should handle network errors', async () => {
      // Note: 503 triggers container retry loop, so we use 500 for permanent errors
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Network error', code: 'GIT_NETWORK_ERROR' }),
          { status: 500 }
        )
      );

      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session')
      ).rejects.toThrow(GitNetworkError);
    });

    it('should handle clone failures', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Clone failed', code: 'GIT_CLONE_FAILED' }),
          { status: 507 }
        )
      );

      await expect(
        client.checkout(
          'https://github.com/large/repository.git',
          'test-session'
        )
      ).rejects.toThrow(GitCloneError);
    });

    it('should handle checkout failures', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Checkout failed',
            code: 'GIT_CHECKOUT_FAILED'
          }),
          { status: 409 }
        )
      );

      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session', {
          branch: 'feature-branch'
        })
      ).rejects.toThrow(GitCheckoutError);
    });

    it('should handle invalid Git URLs', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Invalid Git URL', code: 'INVALID_GIT_URL' }),
          { status: 400 }
        )
      );

      await expect(
        client.checkout('not-a-valid-url', 'test-session')
      ).rejects.toThrow(InvalidGitUrlError);
    });

    it('should handle partial clone failures', async () => {
      const mockResponse: GitCheckoutResult = {
        success: false,
        repoUrl: 'https://github.com/problematic/repo.git',
        branch: 'main',
        targetDir: 'repo',
        timestamp: '2023-01-01T00:01:30Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout(
        'https://github.com/problematic/repo.git',
        'test-session'
      );

      expect(result.success).toBe(false);
    });
  });

  describe('error handling edge cases', () => {
    it('should handle network failures', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session')
      ).rejects.toThrow('Network connection failed');
    });

    it('should handle malformed server responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', { status: 200 })
      );

      await expect(
        client.checkout('https://github.com/user/repo.git', 'test-session')
      ).rejects.toThrow(SandboxError);
    });

    it('should map server errors to client errors', async () => {
      const serverErrorScenarios = [
        { status: 400, code: 'INVALID_GIT_URL', error: InvalidGitUrlError },
        { status: 401, code: 'GIT_AUTH_FAILED', error: GitAuthenticationError },
        {
          status: 404,
          code: 'GIT_REPOSITORY_NOT_FOUND',
          error: GitRepositoryNotFoundError
        },
        {
          status: 404,
          code: 'GIT_BRANCH_NOT_FOUND',
          error: GitBranchNotFoundError
        },
        { status: 500, code: 'GIT_OPERATION_FAILED', error: GitError },
        // Note: 503 triggers container retry loop, so we use 500 for permanent git errors
        { status: 500, code: 'GIT_NETWORK_ERROR', error: GitNetworkError }
      ];

      for (const scenario of serverErrorScenarios) {
        mockFetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: 'Test error', code: scenario.code }),
            { status: scenario.status }
          )
        );

        await expect(
          client.checkout('https://github.com/test/repo.git', 'test-session')
        ).rejects.toThrow(scenario.error);
      }
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', () => {
      const minimalClient = new GitClient();
      expect(minimalClient).toBeInstanceOf(GitClient);
    });

    it('should initialize with full options', () => {
      const fullOptionsClient = new GitClient({
        baseUrl: 'http://custom.com',
        port: 8080
      });
      expect(fullOptionsClient).toBeInstanceOf(GitClient);
    });
  });

  describe('credential redaction in logs', () => {
    it('should redact credentials from URLs but leave public URLs unchanged', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn()
      };

      const clientWithLogger = new GitClient({
        baseUrl: 'http://test.com',
        port: 3000,
        logger: mockLogger
      });

      // Test with credentials
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            repoUrl:
              'https://oauth2:ghp_token123@github.com/user/private-repo.git',
            branch: 'main',
            targetDir: '/workspace/private-repo',
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await clientWithLogger.checkout(
        'https://oauth2:ghp_token123@github.com/user/private-repo.git',
        'test-session'
      );

      let logDetails = mockLogger.info.mock.calls[0]?.[1]?.details;
      expect(logDetails).not.toContain('ghp_token123');
      expect(logDetails).toContain(
        'https://******@github.com/user/private-repo.git'
      );

      // Test without credentials
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            repoUrl: 'https://github.com/facebook/react.git',
            branch: 'main',
            targetDir: '/workspace/react',
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await clientWithLogger.checkout(
        'https://github.com/facebook/react.git',
        'test-session'
      );

      logDetails = mockLogger.info.mock.calls[1]?.[1]?.details;
      expect(logDetails).toContain('https://github.com/facebook/react.git');
    });
  });
});
