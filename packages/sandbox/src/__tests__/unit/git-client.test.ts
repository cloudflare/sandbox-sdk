import type { GitCheckoutResponse, HttpClientOptions } from '../../clients';
import { GitClient } from '../../clients/git-client';

describe('GitClient', () => {
  let client: GitClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new GitClient({
      baseUrl: 'http://test.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultClient = new GitClient();
      expect(defaultClient.getSessionId()).toBeNull();
    });

    it('should initialize with custom options', () => {
      const customClient = new GitClient({
        baseUrl: 'http://custom.com',
        port: 8080,
      });
      
      expect(customClient.getSessionId()).toBeNull();
    });
  });

  describe('checkout', () => {
    const mockResponse: GitCheckoutResponse = {
      success: true,
      stdout: 'Cloning into \'my-repo\'...\nRemote: Counting objects: 42, done.\n',
      stderr: '',
      exitCode: 0,
      repoUrl: 'https://github.com/user/my-repo.git',
      branch: 'main',
      targetDir: 'my-repo',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should clone repository with defaults', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.checkout('https://github.com/user/my-repo.git');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/my-repo.git',
          branch: 'main',
          targetDir: 'my-repo',
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should clone repository with custom branch', async () => {
      const customBranchResponse = { ...mockResponse, branch: 'develop' };
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(customBranchResponse), { status: 200 })
      );

      await client.checkout('https://github.com/user/my-repo.git', { branch: 'develop' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/my-repo.git',
          branch: 'develop',
          targetDir: 'my-repo',
        }),
      });
    });

    it('should clone repository with custom target directory', async () => {
      const customDirResponse = { ...mockResponse, targetDir: 'custom-dir' };
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(customDirResponse), { status: 200 })
      );

      await client.checkout('https://github.com/user/my-repo.git', { targetDir: 'custom-dir' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/my-repo.git',
          branch: 'main',
          targetDir: 'custom-dir',
        }),
      });
    });

    it('should clone repository with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.checkout('https://github.com/user/my-repo.git', { sessionId: 'session-123' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/my-repo.git',
          branch: 'main',
          targetDir: 'my-repo',
          sessionId: 'session-123',
        }),
      });
    });

    it('should clone repository with all custom options', async () => {
      const fullCustomResponse = { 
        ...mockResponse, 
        branch: 'feature/new-feature', 
        targetDir: 'workspace/project' 
      };
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(fullCustomResponse), { status: 200 })
      );

      await client.checkout('https://github.com/user/my-repo.git', {
        branch: 'feature/new-feature',
        targetDir: 'workspace/project',
        sessionId: 'session-456',
      });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/my-repo.git',
          branch: 'feature/new-feature',
          targetDir: 'workspace/project',
          sessionId: 'session-456',
        }),
      });
    });

    it('should handle repository not found error', async () => {
      const errorResponse = {
        error: 'Repository not found',
        code: 'GIT_REPOSITORY_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.checkout('https://github.com/user/nonexistent.git')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle authentication error', async () => {
      const errorResponse = {
        error: 'Authentication failed',
        code: 'GIT_AUTH_FAILED',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 401 })
      );

      await expect(client.checkout('https://github.com/user/private-repo.git')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle branch not found error', async () => {
      const errorResponse = {
        error: 'Branch not found',
        code: 'GIT_BRANCH_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.checkout('https://github.com/user/repo.git', { branch: 'nonexistent' })).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle network error during clone', async () => {
      const errorResponse = {
        error: 'Network error',
        code: 'GIT_NETWORK_ERROR',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 502 })
      );

      await expect(client.checkout('https://github.com/user/repo.git')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle invalid Git URL error', async () => {
      const errorResponse = {
        error: 'Invalid Git URL',
        code: 'INVALID_GIT_URL',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 400 })
      );

      await expect(client.checkout('not-a-valid-url')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle clone failure error', async () => {
      const errorResponse = {
        error: 'Clone failed',
        code: 'GIT_CLONE_FAILED',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.checkout('https://github.com/user/repo.git')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle network failures', async () => {
      const networkError = new Error('Connection failed');
      fetchMock.mockRejectedValue(networkError);

      await expect(client.checkout('https://github.com/user/repo.git')).rejects.toThrow('Connection failed');
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('extractRepoName', () => {
    it('should extract repo name from GitHub HTTPS URL', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ 
          ...{
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            repoUrl: 'https://github.com/user/my-repo.git',
            branch: 'main',
            targetDir: 'my-repo',
            timestamp: '2023-01-01T00:00:00Z',
          }
        }), { status: 200 })
      );

      await client.checkout('https://github.com/user/my-repo.git');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', 
        expect.objectContaining({
          body: expect.stringContaining('"targetDir":"my-repo"')
        })
      );
    });

    it('should extract repo name from GitHub SSH URL', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ 
          ...{
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            repoUrl: 'git@github.com:user/awesome-project.git',
            branch: 'main',
            targetDir: 'awesome-project',
            timestamp: '2023-01-01T00:00:00Z',
          }
        }), { status: 200 })
      );

      await client.checkout('git@github.com:user/awesome-project.git');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', 
        expect.objectContaining({
          body: expect.stringContaining('"targetDir":"awesome-project"')
        })
      );
    });

    it('should extract repo name from URL without .git extension', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ 
          ...{
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            repoUrl: 'https://gitlab.com/user/my-project',
            branch: 'main',
            targetDir: 'my-project',
            timestamp: '2023-01-01T00:00:00Z',
          }
        }), { status: 200 })
      );

      await client.checkout('https://gitlab.com/user/my-project');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', 
        expect.objectContaining({
          body: expect.stringContaining('"targetDir":"my-project"')
        })
      );
    });

    it('should handle invalid URLs gracefully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ 
          ...{
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            repoUrl: 'invalid-url',
            branch: 'main',
            targetDir: 'invalid-url',
            timestamp: '2023-01-01T00:00:00Z',
          }
        }), { status: 200 })
      );

      await client.checkout('invalid-url');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', 
        expect.objectContaining({
          body: expect.stringContaining('"targetDir":"invalid-url"')
        })
      );
    });

    it('should provide fallback for empty URLs', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ 
          ...{
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            repoUrl: '/',
            branch: 'main',
            targetDir: 'repo',
            timestamp: '2023-01-01T00:00:00Z',
          }
        }), { status: 200 })
      );

      await client.checkout('/');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', 
        expect.objectContaining({
          body: expect.stringContaining('"targetDir":"repo"')
        })
      );
    });
  });

  describe('session management integration', () => {
    it('should use instance session ID when none provided', async () => {
      const mockResponse: GitCheckoutResponse = {
        success: true,
        stdout: 'Clone successful',
        stderr: '',
        exitCode: 0,
        repoUrl: 'https://github.com/user/repo.git',
        branch: 'main',
        targetDir: 'repo',
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      client.setSessionId('instance-session');
      await client.checkout('https://github.com/user/repo.git');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/git/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/repo.git',
          branch: 'main',
          targetDir: 'repo',
          sessionId: 'instance-session',
        }),
      });
    });
  });
});