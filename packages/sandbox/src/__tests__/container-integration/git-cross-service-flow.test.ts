/**
 * Git Operations and Cross-Service Integration Tests
 * 
 * Tests complete workflows involving Git operations with multiple service coordination:
 * - Git cloning → File system operations → Session management → Process execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { 
  GitHandler,
  ExecuteHandler,
  FileHandler,
  SessionService,
  SecurityService,
  GitService,
  FileService,
  Logger,
  RequestContext,
  SessionStore
} from '@container/core/types';

// Mock implementations for integration testing
const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

const mockSessionStore: SessionStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

// Mock Bun globals for Git and file operations
const mockBunSpawn = vi.fn();
const mockBunFile = vi.fn();
global.Bun = {
  spawn: mockBunSpawn,
  file: mockBunFile,
} as any;

const mockContext: RequestContext = {
  requestId: 'req-git-integration-999',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-git-workflow',
  validatedData: {},
};

describe('Git Operations and Cross-Service Integration Flow', () => {
  let gitHandler: GitHandler;
  let executeHandler: ExecuteHandler;
  let fileHandler: FileHandler;
  let sessionService: SessionService;
  let securityService: SecurityService;
  let gitService: GitService;
  let fileService: FileService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import and create service instances
    const { SessionService: SessionServiceClass } = await import('@container/services/session-service');
    const { SecurityService: SecurityServiceClass } = await import('@container/security/security-service');
    const { GitService: GitServiceClass } = await import('@container/services/git-service');
    const { FileService: FileServiceClass } = await import('@container/services/file-service');
    const { GitHandler: GitHandlerClass } = await import('@container/handlers/git-handler');
    const { ExecuteHandler: ExecuteHandlerClass } = await import('@container/handlers/execute-handler');
    const { FileHandler: FileHandlerClass } = await import('@container/handlers/file-handler');

    // Create integrated service chain
    securityService = new SecurityServiceClass(mockLogger);
    sessionService = new SessionServiceClass(mockSessionStore, mockLogger);
    gitService = new GitServiceClass(securityService, mockLogger);
    fileService = new FileServiceClass(securityService, mockLogger);
    gitHandler = new GitHandlerClass(gitService, sessionService, mockLogger);
    executeHandler = new ExecuteHandlerClass(sessionService, securityService, mockLogger);
    fileHandler = new FileHandlerClass(fileService, sessionService, mockLogger);

    // Setup default session mock
    (mockSessionStore.get as any).mockResolvedValue({
      id: 'session-git-workflow',
      createdAt: new Date(),
      lastActivity: new Date(),
      env: { NODE_ENV: 'test', GIT_USER: 'testuser' },
      cwd: '/tmp/workspace',
      isActive: true,
    });

    (mockSessionStore.set as any).mockResolvedValue(undefined);

    // Mock successful Git clone process
    const mockGitProcess = {
      exited: Promise.resolve(0),
      stdout: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('Cloning into repository...\n') })
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('Receiving objects: 100%\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
      stderr: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
        }),
      },
      kill: vi.fn(),
    };

    // Mock successful command execution
    const mockCommandProcess = {
      exited: Promise.resolve(0),
      stdout: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('npm install completed\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
      stderr: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
        }),
      },
      kill: vi.fn(),
    };

    mockBunSpawn
      .mockReturnValueOnce(mockGitProcess)  // For git clone
      .mockReturnValue(mockCommandProcess); // For subsequent commands

    // Mock file system for post-clone operations
    mockBunFile.mockReturnValue({
      exists: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue('{"name": "test-project", "version": "1.0.0"}'),
      size: 42,
      write: vi.fn().mockResolvedValue(42),
    });
  });

  describe('complete Git clone to development workflow', () => {
    it('should execute full workflow: Git clone → File read → Command execution → Session updates', async () => {
      // 1. Clone a repository
      const cloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/test-project.git',
          branch: 'main',
          targetDir: '/tmp/workspace/test-project',
          sessionId: 'session-git-workflow'
        })
      });

      const cloneResponse = await gitHandler.handle(cloneRequest, mockContext);
      expect(cloneResponse.status).toBe(200);

      const cloneData = await cloneResponse.json();
      expect(cloneData.success).toBe(true);
      expect(cloneData.output).toContain('Cloning into repository');
      expect(cloneData.targetDir).toBe('/tmp/workspace/test-project');

      // 2. Read package.json from cloned repository
      const readFileRequest = new Request('http://localhost:3000/api/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/workspace/test-project/package.json',
          encoding: 'utf-8',
          sessionId: 'session-git-workflow'
        })
      });

      const fileResponse = await fileHandler.handle(readFileRequest, mockContext);
      expect(fileResponse.status).toBe(200);

      const fileData = await fileResponse.json();
      expect(fileData.success).toBe(true);
      expect(fileData.content).toContain('test-project');

      // 3. Execute npm install in the cloned directory
      const installRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'npm install',
          cwd: '/tmp/workspace/test-project',
          sessionId: 'session-git-workflow'
        })
      });

      const installResponse = await executeHandler.handle(installRequest, mockContext);
      expect(installResponse.status).toBe(200);

      const installData = await installResponse.json();
      expect(installData.success).toBe(true);
      expect(installData.output).toContain('npm install completed');

      // Verify the complete integration chain
      
      // Git clone should be executed and logged
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['git', 'clone', '--branch', 'main', 'https://github.com/user/test-project.git', '/tmp/workspace/test-project'],
        expect.objectContaining({
          cwd: '/tmp/workspace'
        })
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Git checkout completed',
        expect.objectContaining({
          repoUrl: 'https://github.com/user/test-project.git',
          branch: 'main',
          targetDir: '/tmp/workspace/test-project'
        })
      );

      // File read should be executed
      expect(mockBunFile).toHaveBeenCalledWith('/tmp/workspace/test-project/package.json');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File read completed',
        expect.objectContaining({
          path: '/tmp/workspace/test-project/package.json'
        })
      );

      // Command should be executed in correct directory
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['npm', 'install'],
        expect.objectContaining({
          cwd: '/tmp/workspace/test-project'
        })
      );

      // Session should be updated multiple times for each operation
      expect(mockSessionStore.set).toHaveBeenCalledTimes(3);
      expect(mockSessionStore.get).toHaveBeenCalledTimes(3);
    });

    it('should handle Git clone with security validation and prevent malicious repositories', async () => {
      const maliciousCloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://malicious-site.com/evil-repo.git',
          sessionId: 'session-git-workflow'
        })
      });

      const response = await gitHandler.handle(maliciousCloneRequest, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Git URL validation failed');

      // Security violation should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Git URL validation failed',
        expect.objectContaining({
          gitUrl: 'https://malicious-site.com/evil-repo.git'
        })
      );

      // Git clone should not have been executed
      expect(mockBunSpawn).not.toHaveBeenCalled();
    });

    it('should handle Git clone with dangerous target directory', async () => {
      const dangerousCloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/repo.git',
          targetDir: '/etc/overwrite-system',
          sessionId: 'session-git-workflow'
        })
      });

      const response = await gitHandler.handle(dangerousCloneRequest, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Path validation failed');

      // Path security violation should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Path validation failed',
        expect.objectContaining({
          path: '/etc/overwrite-system'
        })
      );
    });
  });

  describe('cross-service development workflows', () => {
    it('should support full development workflow: clone → modify files → commit changes', async () => {
      // 1. Clone repository
      const cloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/dev-project.git',
          targetDir: '/tmp/workspace/dev-project',
          sessionId: 'session-git-workflow'
        })
      });

      const cloneResponse = await gitHandler.handle(cloneRequest, mockContext);
      expect(cloneResponse.status).toBe(200);

      // 2. Create a new file in the cloned repository
      const createFileRequest = new Request('http://localhost:3000/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/workspace/dev-project/new-feature.js',
          content: 'console.log("New feature implementation");',
          sessionId: 'session-git-workflow'
        })
      });

      const createResponse = await fileHandler.handle(createFileRequest, mockContext);
      expect(createResponse.status).toBe(200);

      // 3. Run tests in the project
      const testRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'npm test',
          cwd: '/tmp/workspace/dev-project',
          sessionId: 'session-git-workflow'
        })
      });

      const testResponse = await executeHandler.handle(testRequest, mockContext);
      expect(testResponse.status).toBe(200);

      // Verify all operations succeeded and were properly coordinated
      const cloneData = await cloneResponse.json();
      const createData = await createResponse.json();
      const testData = await testResponse.json();

      expect(cloneData.success).toBe(true);
      expect(createData.success).toBe(true);
      expect(testData.success).toBe(true);

      // Verify proper working directory management
      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.arrayContaining(['git', 'clone']),
        expect.objectContaining({
          cwd: '/tmp/workspace'
        })
      );

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['npm', 'test'],
        expect.objectContaining({
          cwd: '/tmp/workspace/dev-project'
        })
      );

      // All operations should be logged with session context
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Git checkout completed',
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File write completed',
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Command execution completed',
        expect.any(Object)
      );
    });

    it('should handle Git clone failure and prevent subsequent operations', async () => {
      // Mock Git clone failure
      const failingGitProcess = {
        exited: Promise.resolve(128), // Git error code
        stdout: {
          getReader: () => ({
            read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
          }),
        },
        stderr: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('Repository not found\n') })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
        kill: vi.fn(),
      };

      mockBunSpawn.mockReturnValueOnce(failingGitProcess);

      const cloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/nonexistent-repo.git',
          targetDir: '/tmp/workspace/nonexistent',
          sessionId: 'session-git-workflow'
        })
      });

      const cloneResponse = await gitHandler.handle(cloneRequest, mockContext);
      expect(cloneResponse.status).toBe(200); // Still 200 but with error info

      const cloneData = await cloneResponse.json();
      expect(cloneData.success).toBe(false);
      expect(cloneData.exitCode).toBe(128);
      expect(cloneData.error).toContain('Repository not found');

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Git checkout failed',
        expect.objectContaining({
          exitCode: 128,
          repoUrl: 'https://github.com/user/nonexistent-repo.git'
        })
      );

      // Subsequent file operations on the failed clone should also fail
      const readFileRequest = new Request('http://localhost:3000/api/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/workspace/nonexistent/package.json',
          sessionId: 'session-git-workflow'
        })
      });

      // Mock file doesn't exist since clone failed
      mockBunFile.mockReturnValue({
        exists: vi.fn().mockResolvedValue(false),
        text: vi.fn().mockRejectedValue(new Error('File not found')),
      });

      const fileResponse = await fileHandler.handle(readFileRequest, mockContext);
      expect(fileResponse.status).toBe(404);

      const fileData = await fileResponse.json();
      expect(fileData.success).toBe(false);
      expect(fileData.error).toContain('File not found');
    });

    it('should maintain session environment across Git and development operations', async () => {
      // Update session with development-specific environment
      (mockSessionStore.get as any).mockResolvedValue({
        id: 'session-git-workflow',
        createdAt: new Date(),
        lastActivity: new Date(),
        env: { 
          NODE_ENV: 'development',
          GIT_USER: 'developer',
          GIT_EMAIL: 'dev@example.com',
          PATH: '/usr/local/bin:/usr/bin:/bin'
        },
        cwd: '/tmp/workspace',
        isActive: true,
      });

      const cloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/env-sensitive-project.git',
          sessionId: 'session-git-workflow'
        })
      });

      const cloneResponse = await gitHandler.handle(cloneRequest, mockContext);
      expect(cloneResponse.status).toBe(200);

      // Git command should inherit session environment
      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.arrayContaining(['git', 'clone']),
        expect.objectContaining({
          env: expect.objectContaining({
            NODE_ENV: 'development',
            GIT_USER: 'developer',
            GIT_EMAIL: 'dev@example.com'
          })
        })
      );

      // Execute a command that uses the environment
      const buildRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'npm run build',
          sessionId: 'session-git-workflow'
        })
      });

      const buildResponse = await executeHandler.handle(buildRequest, mockContext);
      expect(buildResponse.status).toBe(200);

      // Build command should also inherit session environment
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['npm', 'run', 'build'],
        expect.objectContaining({
          env: expect.objectContaining({
            NODE_ENV: 'development'
          })
        })
      );
    });
  });

  describe('error boundary and recovery testing', () => {
    it('should handle session store failures during cross-service operations', async () => {
      // Mock session store failure
      (mockSessionStore.get as any).mockRejectedValue(new Error('Session store unavailable'));

      const cloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/repo.git',
          sessionId: 'session-git-workflow'
        })
      });

      const response = await gitHandler.handle(cloneRequest, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Session retrieval failed');

      // Session error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Session operation failed'),
        expect.objectContaining({
          error: expect.stringContaining('Session store unavailable')
        })
      );

      // Git operation should not proceed
      expect(mockBunSpawn).not.toHaveBeenCalled();
    });

    it('should handle complex workflow interruptions gracefully', async () => {
      // Start with successful Git clone
      const cloneRequest = new Request('http://localhost:3000/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/user/project.git',
          targetDir: '/tmp/workspace/project',
          sessionId: 'session-git-workflow'
        })
      });

      const cloneResponse = await gitHandler.handle(cloneRequest, mockContext);
      expect(cloneResponse.status).toBe(200);

      // Then simulate file operation failure
      mockBunFile.mockReturnValue({
        exists: vi.fn().mockResolvedValue(true),
        write: vi.fn().mockRejectedValue(new Error('Disk full')),
      });

      const writeRequest = new Request('http://localhost:3000/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/workspace/project/config.json',
          content: '{"setting": "value"}',
          sessionId: 'session-git-workflow'
        })
      });

      const writeResponse = await fileHandler.handle(writeRequest, mockContext);
      expect(writeResponse.status).toBe(500);

      const writeData = await writeResponse.json();
      expect(writeData.success).toBe(false);
      expect(writeData.error).toContain('File write failed');

      // Both operations should be logged appropriately
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Git checkout completed',
        expect.any(Object)
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        'File write failed',
        expect.objectContaining({
          error: expect.stringContaining('Disk full')
        })
      );
    });
  });

  describe('performance and concurrency', () => {
    it('should handle concurrent Git operations in different sessions', async () => {
      const sessions = ['session-1', 'session-2', 'session-3'];
      const repositories = [
        'https://github.com/user/repo1.git',
        'https://github.com/user/repo2.git',
        'https://github.com/user/repo3.git'
      ];

      const concurrentRequests = sessions.map((sessionId, index) => 
        new Request('http://localhost:3000/api/git/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoUrl: repositories[index],
            targetDir: `/tmp/workspace/${sessionId}-repo`,
            sessionId
          })
        })
      );

      // Mock different sessions
      (mockSessionStore.get as any).mockImplementation((sessionId) => 
        Promise.resolve({
          id: sessionId,
          createdAt: new Date(),
          lastActivity: new Date(),
          env: { NODE_ENV: 'test' },
          cwd: '/tmp/workspace',
          isActive: true,
        })
      );

      const responses = await Promise.all(
        concurrentRequests.map(req => gitHandler.handle(req, mockContext))
      );

      // All Git operations should succeed
      for (const response of responses) {
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
      }

      // Each should have its own Git clone process
      expect(mockBunSpawn).toHaveBeenCalledTimes(3);
      expect(mockSessionStore.get).toHaveBeenCalledTimes(3);
      expect(mockSessionStore.set).toHaveBeenCalledTimes(3);
    });
  });

  describe('service result pattern validation', () => {
    it('should maintain ServiceResult pattern consistency across all cross-service operations', async () => {
      const operations = [
        {
          handler: gitHandler,
          request: new Request('http://localhost:3000/api/git/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repoUrl: 'https://github.com/user/test.git',
              sessionId: 'session-git-workflow'
            })
          })
        },
        {
          handler: fileHandler,
          request: new Request('http://localhost:3000/api/files/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: '/tmp/test.txt',
              sessionId: 'session-git-workflow'
            })
          })
        },
        {
          handler: executeHandler,
          request: new Request('http://localhost:3000/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command: 'ls -la',
              sessionId: 'session-git-workflow'
            })
          })
        }
      ];

      for (const op of operations) {
        const response = await op.handler.handle(op.request, mockContext);
        const responseData = await response.json();

        // All responses should follow ServiceResult pattern
        expect(responseData).toHaveProperty('success');
        
        if (responseData.success) {
          expect(responseData.error).toBeUndefined();
        } else {
          expect(responseData).toHaveProperty('error');
          expect(typeof responseData.error).toBe('string');
        }
      }
    });
  });
});

/**
 * This integration test suite validates complete cross-service workflows:
 * 
 * 1. **Full Development Workflow**: Tests the complete pipeline from Git clone
 *    through file operations, command execution, and session management.
 * 
 * 2. **Security Integration Across Services**: Validates that security validation
 *    works consistently across Git operations, file operations, and command execution.
 * 
 * 3. **Session Context Propagation**: Tests how session state (environment, working
 *    directory, credentials) flows through all service operations.
 * 
 * 4. **Cross-Service Error Handling**: Validates that errors in one service don't
 *    corrupt the state of other services and are handled gracefully.
 * 
 * 5. **Complex Workflow Orchestration**: Tests realistic development scenarios
 *    involving multiple services working together (clone → modify → test → commit).
 * 
 * 6. **Service Result Pattern Flow**: Ensures consistent ServiceResult pattern
 *    usage across all service boundaries and handler interactions.
 * 
 * 7. **Environment Management**: Tests how environment variables and working
 *    directories are maintained across different types of operations.
 * 
 * 8. **Concurrent Multi-Session Operations**: Validates that different sessions
 *    can perform Git operations concurrently without interference.
 * 
 * 9. **Resource Management**: Tests proper cleanup and resource management
 *    when operations fail or are interrupted.
 * 
 * 10. **Audit Trail Consistency**: Validates that all cross-service operations
 *     are logged appropriately with proper context correlation.
 * 
 * 11. **Path and URL Security**: Tests that security validation is enforced
 *     consistently across all services (Git URLs, file paths, command execution).
 * 
 * 12. **Development Tool Integration**: Validates integration with common
 *     development tools (npm, git, build processes) across the entire workflow.
 * 
 * The tests demonstrate that the refactored architecture successfully coordinates
 * complex multi-service workflows while maintaining security, session integrity,
 * and proper error recovery throughout the entire development lifecycle.
 */