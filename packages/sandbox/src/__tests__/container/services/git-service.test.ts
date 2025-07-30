/**
 * Git Service Tests
 * 
 * Tests the GitService class from the refactored container architecture.
 * Demonstrates testing services with git operations and security integration.
 */

import type { GitService, SecurityService } from '@container/services/git-service';
import type { Logger } from '@container/core/types';

// Mock the dependencies
const mockSecurityService: SecurityService = {
  validateGitUrl: vi.fn(),
  validatePath: vi.fn(),
  sanitizePath: vi.fn(),
};

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

// Mock Bun.spawn for git command execution
const mockBunSpawn = vi.fn();

// Mock Response for stream reading with dynamic text extraction
global.Response = vi.fn().mockImplementation((stream: BodyInit | null | undefined) => {
  return {
    text: vi.fn().mockImplementation(async () => {
      if (stream && typeof stream === 'object' && 'getReader' in stream) {
        const reader = (stream as ReadableStream).getReader();
        const chunks = [];
        let done = false;
        
        while (!done) {
          try {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            if (value) {
              chunks.push(value);
            }
          } catch {
            break;
          }
        }
        
        // Combine chunks and decode
        const combined = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        
        return new TextDecoder().decode(combined).trim();
      }
      return '';
    })
  };
}) as any;

// Mock Bun global
global.Bun = {
  spawn: mockBunSpawn,
} as any;

describe('GitService', () => {
  let gitService: GitService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Set up default successful security validations
    (mockSecurityService.validateGitUrl as any).mockReturnValue({
      isValid: true,
      errors: []
    });
    (mockSecurityService.validatePath as any).mockReturnValue({
      isValid: true,
      errors: []
    });

    // Import the GitService (dynamic import)
    const { GitService: GitServiceClass } = await import('@container/services/git-service');
    gitService = new GitServiceClass(mockSecurityService, mockLogger);
  });

  describe('cloneRepository', () => {
    it('should clone repository successfully with default options', async () => {
      // Mock successful git clone
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Cloning into target-dir...'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.cloneRepository('https://github.com/user/repo.git');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.path).toMatch(/^\/tmp\/git-clone-repo-\d+-[a-z0-9]+$/);
        expect(result.data.branch).toBe('main');
      }

      // Verify security validations were called
      expect(mockSecurityService.validateGitUrl).toHaveBeenCalledWith('https://github.com/user/repo.git');
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith(
        expect.stringMatching(/^\/tmp\/git-clone-repo-\d+-[a-z0-9]+$/)
      );

      // Verify git clone command was executed
      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.arrayContaining(['git', 'clone', 'https://github.com/user/repo.git']),
        expect.objectContaining({
          stdout: 'pipe',
          stderr: 'pipe'
        })
      );

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cloning repository',
        expect.objectContaining({
          repoUrl: 'https://github.com/user/repo.git',
          targetDirectory: expect.stringMatching(/^\/tmp\/git-clone-repo-\d+-[a-z0-9]+$/),
          branch: undefined
        })
      );
    });

    it('should clone repository with custom branch and target directory', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Cloning...'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const options = {
        branch: 'develop',
        targetDir: '/tmp/custom-target'
      };

      const result = await gitService.cloneRepository('https://github.com/user/repo.git', options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.path).toBe('/tmp/custom-target');
        expect(result.data.branch).toBe('develop');
      }

      // Verify git clone command includes branch option
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['git', 'clone', '--branch', 'develop', 'https://github.com/user/repo.git', '/tmp/custom-target'],
        expect.objectContaining({
          stdout: 'pipe',
          stderr: 'pipe'
        })
      );
    });

    it('should return error when git URL validation fails', async () => {
      (mockSecurityService.validateGitUrl as any).mockReturnValue({
        isValid: false,
        errors: ['Invalid URL scheme', 'URL not in allowlist']
      });

      const result = await gitService.cloneRepository('ftp://malicious.com/repo.git');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_GIT_URL');
        expect(result.error.message).toContain('Invalid URL scheme');
        expect(result.error.details?.errors).toEqual([
          'Invalid URL scheme', 
          'URL not in allowlist'
        ]);
      }

      // Should not attempt git clone
      expect(mockBunSpawn).not.toHaveBeenCalled();
    });

    it('should return error when target directory validation fails', async () => {
      (mockSecurityService.validatePath as any).mockReturnValue({
        isValid: false,
        errors: ['Path outside sandbox', 'Path contains invalid characters']
      });

      const result = await gitService.cloneRepository(
        'https://github.com/user/repo.git',
        { targetDir: '/malicious/../path' }
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TARGET_PATH');
        expect(result.error.details?.errors).toContain('Path outside sandbox');
      }

      // Should not attempt git clone
      expect(mockBunSpawn).not.toHaveBeenCalled();
    });

    it('should return error when git clone command fails', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 128,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('fatal: repository not found'));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.cloneRepository('https://github.com/user/nonexistent.git');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('GIT_CLONE_FAILED');
        expect(result.error.details?.exitCode).toBe(128);
        expect(result.error.details?.stderr).toContain('repository not found');
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Git clone failed',
        undefined,
        expect.objectContaining({
          exitCode: 128,
          stderr: expect.stringContaining('repository not found')
        })
      );
    });

    it('should handle spawn errors gracefully', async () => {
      const spawnError = new Error('Command not found');
      mockBunSpawn.mockImplementation(() => {
        throw spawnError;
      });

      const result = await gitService.cloneRepository('https://github.com/user/repo.git');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('GIT_CLONE_ERROR');
        expect(result.error.details?.originalError).toBe('Command not found');
      }
    });
  });

  describe('checkoutBranch', () => {
    it('should checkout branch successfully', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Switched to branch develop'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.checkoutBranch('/tmp/repo', 'develop');

      expect(result.success).toBe(true);
      
      // Verify git checkout command was executed with correct cwd
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['git', 'checkout', 'develop'],
        expect.objectContaining({
          cwd: '/tmp/repo',
          stdout: 'pipe',
          stderr: 'pipe'
        })
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Branch checked out successfully',
        { repoPath: '/tmp/repo', branch: 'develop' }
      );
    });

    it('should return error when repository path validation fails', async () => {
      (mockSecurityService.validatePath as any).mockReturnValue({
        isValid: false,
        errors: ['Invalid repository path']
      });

      const result = await gitService.checkoutBranch('/invalid/path', 'develop');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_REPO_PATH');
      }

      expect(mockBunSpawn).not.toHaveBeenCalled();
    });

    it('should return error when branch name is empty', async () => {
      const result = await gitService.checkoutBranch('/tmp/repo', '');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_BRANCH_NAME');
        expect(result.error.message).toBe('Branch name cannot be empty');
      }

      expect(mockBunSpawn).not.toHaveBeenCalled();
    });

    it('should return error when git checkout fails', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 1,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('error: pathspec \'nonexistent\' did not match'));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.checkoutBranch('/tmp/repo', 'nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('GIT_CHECKOUT_FAILED');
        expect(result.error.details?.stderr).toContain('did not match');
      }
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch successfully', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('main\n'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.getCurrentBranch('/tmp/repo');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('main');
      }

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['git', 'branch', '--show-current'],
        expect.objectContaining({
          cwd: '/tmp/repo',
          stdout: 'pipe',
          stderr: 'pipe'
        })
      );
    });

    it('should return error when git command fails', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 128,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('fatal: not a git repository'));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.getCurrentBranch('/tmp/not-a-repo');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('GIT_BRANCH_ERROR');
        expect(result.error.details?.exitCode).toBe(128);
      }
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

      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(branchOutput));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.listBranches('/tmp/repo');

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
        expect(result.data.filter(b => b === 'main')).toHaveLength(1);
      }

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['git', 'branch', '-a'],
        expect.objectContaining({
          cwd: '/tmp/repo',
          stdout: 'pipe',
          stderr: 'pipe'
        })
      );
    });

    it('should handle empty branch list', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('\n\n'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.listBranches('/tmp/empty-repo');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it('should return error when git branch command fails', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 128,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('fatal: not a git repository'));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await gitService.listBranches('/tmp/not-a-repo');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('GIT_BRANCH_LIST_ERROR');
        expect(result.error.details?.exitCode).toBe(128);
      }
    });
  });

  describe('target directory generation', () => {
    it('should generate unique target directory from repository URL', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Cloning...'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      // Test with different repository URLs
      const testCases = [
        'https://github.com/user/my-awesome-repo.git',
        'https://gitlab.com/org/project.git',
        'git@github.com:user/private-repo.git'
      ];

      for (const repoUrl of testCases) {
        await gitService.cloneRepository(repoUrl);
        
        // Verify that unique directory was generated
        const calls = mockBunSpawn.mock.calls;
        const lastCall = calls[calls.length - 1];
        const targetDir = lastCall[0][lastCall[0].length - 1]; // Last argument is target directory
        
        expect(targetDir).toMatch(/^\/tmp\/git-clone-.+$/);
      }
    });

    it('should handle invalid URLs gracefully in directory generation', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Cloning...'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      // Test with invalid URL that would break URL parsing
      await gitService.cloneRepository('not-a-valid-url');
      
      const calls = mockBunSpawn.mock.calls;
      const lastCall = calls[calls.length - 1];
      const targetDir = lastCall[0][lastCall[0].length - 1];
      
      // Should generate fallback directory name
      expect(targetDir).toMatch(/^\/tmp\/git-clone-\d+-[a-z0-9]+$/);
    });
  });

  describe('error handling patterns', () => {
    it('should handle non-Error exceptions consistently', async () => {
      mockBunSpawn.mockImplementation(() => {
        throw 'String error';
      });

      const result = await gitService.cloneRepository('https://github.com/user/repo.git');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.details?.originalError).toBe('Unknown error');
      }
    });

    it('should include proper context in all error responses', async () => {
      const testRepoUrl = 'https://github.com/user/repo.git';
      const testBranch = 'feature-branch';
      
      (mockSecurityService.validateGitUrl as any).mockReturnValue({
        isValid: false,
        errors: ['Invalid URL']
      });

      const result = await gitService.cloneRepository(testRepoUrl);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.details?.repoUrl).toBe(testRepoUrl);
        expect(result.error.message).toContain('Git URL validation failed');
      }
    });

    it('should validate paths for all operations that require them', async () => {
      const testPath = '/tmp/test-repo';
      
      // Test all path-dependent operations
      await gitService.checkoutBranch(testPath, 'main');
      await gitService.getCurrentBranch(testPath);
      await gitService.listBranches(testPath);

      // Should validate path for all operations
      expect(mockSecurityService.validatePath).toHaveBeenCalledTimes(3);
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith(testPath);
    });
  });

  describe('logging integration', () => {
    it('should log all major operations with appropriate context', async () => {
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('success'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      };
      // Set up mock to return successful process for multiple calls
      // Create fresh streams for each call to avoid "ReadableStream is locked" errors
      mockBunSpawn.mockImplementation(() => ({
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('success'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(''));
            controller.close();
          }
        })
      }));

      const repoUrl = 'https://github.com/user/repo.git';
      const repoPath = '/tmp/repo';
      const branch = 'develop';

      // Test successful operations logging
      await gitService.cloneRepository(repoUrl, { branch, targetDir: repoPath });
      await gitService.checkoutBranch(repoPath, branch);

      // Verify info logging for successful operations
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cloning repository',
        expect.objectContaining({ repoUrl, targetDirectory: repoPath, branch })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Repository cloned successfully',
        expect.objectContaining({ repoUrl, targetDirectory: repoPath, branch })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Checking out branch',
        { repoPath, branch }
      );
      expect(mockLogger.info).toHaveBeenLastCalledWith(
        'Branch checked out successfully',
        { repoPath, branch }
      );
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored GitService:
 * 
 * 1. **Security Integration Testing**: GitService integrates with SecurityService
 *    for URL and path validation, which we test through comprehensive mocking.
 * 
 * 2. **Command Execution Mocking**: The service uses Bun.spawn() to execute git
 *    commands. We mock this to test both success and failure scenarios.
 * 
 * 3. **Stream Processing Testing**: Git commands output streams that need to be
 *    processed. We test stream parsing and output handling.
 * 
 * 4. **ServiceResult Pattern**: All methods return ServiceResult<T>, enabling
 *    consistent testing of success/error scenarios.
 * 
 * 5. **Complex Output Parsing**: Tests validate that git branch output is correctly
 *    parsed, deduplicated, and cleaned up.
 * 
 * 6. **Directory Generation Logic**: Tests ensure unique directory names are
 *    generated and handle edge cases like invalid URLs.
 * 
 * 7. **Comprehensive Error Scenarios**: Tests cover validation failures, command
 *    failures, invalid inputs, and exception handling.
 * 
 * 8. **Git Workflow Testing**: Tests validate complete git workflows including
 *    clone → checkout → branch operations.
 */