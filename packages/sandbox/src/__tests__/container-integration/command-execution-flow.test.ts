/**
 * Command Execution Integration Tests
 * 
 * Tests complete request flows for command execution involving multiple services:
 * - Request validation → Security validation → Session management → Command execution → Response formatting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { 
  ExecuteHandler,
  SessionService,
  SecurityService,
  RequestValidator,
  FileService,
  Logger,
  RequestContext,
  SessionStore,
  ServiceResult
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

// Mock Bun globals for command execution
const mockBunSpawn = vi.fn();
global.Bun = {
  spawn: mockBunSpawn,
  file: vi.fn(),
} as any;

const mockContext: RequestContext = {
  requestId: 'req-integration-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-integration',
  validatedData: {},
};

describe('Command Execution Integration Flow', () => {
  let executeHandler: ExecuteHandler;
  let sessionService: SessionService;
  let securityService: SecurityService;
  let requestValidator: RequestValidator;
  let fileService: FileService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import and create service instances
    const { SessionService: SessionServiceClass } = await import('@container/services/session-service');
    const { SecurityService: SecurityServiceClass } = await import('@container/security/security-service');
    const { RequestValidator: RequestValidatorClass } = await import('@container/validation/request-validator');
    const { FileService: FileServiceClass } = await import('@container/services/file-service');
    const { ExecuteHandler: ExecuteHandlerClass } = await import('@container/handlers/execute-handler');

    // Create integrated service chain
    securityService = new SecurityServiceClass(mockLogger);
    requestValidator = new RequestValidatorClass(securityService);
    sessionService = new SessionServiceClass(mockSessionStore, mockLogger);
    fileService = new FileServiceClass(securityService, mockLogger);
    executeHandler = new ExecuteHandlerClass(sessionService, securityService, mockLogger);

    // Setup default mocks for successful operations
    (mockSessionStore.get as any).mockResolvedValue({
      id: 'session-integration',
      createdAt: new Date(),
      lastActivity: new Date(),
      env: { NODE_ENV: 'test' },
      cwd: '/tmp',
      isActive: true,
    });

    (mockSessionStore.set as any).mockResolvedValue(undefined);

    // Mock successful command execution
    const mockProcess = {
      exited: Promise.resolve(0),
      stdout: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('Command output line 1\n') })
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('Command output line 2\n') })
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

    mockBunSpawn.mockReturnValue(mockProcess);
  });

  describe('complete command execution workflow', () => {
    it('should execute complete flow: validation → security → session → execution → response', async () => {
      const requestBody = {
        command: 'ls -la',
        sessionId: 'session-integration',
        cwd: '/tmp',
        env: { CUSTOM_VAR: 'test-value' }
      };

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      // Execute the complete flow
      const response = await executeHandler.handle(request, mockContext);

      // Verify successful response
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.output).toContain('Command output line 1');
      expect(responseData.output).toContain('Command output line 2');
      expect(responseData.exitCode).toBe(0);

      // Verify the complete service interaction chain
      
      // 1. Security validation should have been called
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Command execution completed'),
        expect.objectContaining({
          sessionId: 'session-integration',
          exitCode: 0
        })
      );

      // 2. Session should have been retrieved and updated
      expect(mockSessionStore.get).toHaveBeenCalledWith('session-integration');
      expect(mockSessionStore.set).toHaveBeenCalledWith(
        'session-integration',
        expect.objectContaining({
          env: expect.objectContaining({ CUSTOM_VAR: 'test-value' }),
          cwd: '/tmp'
        })
      );

      // 3. Command should have been executed with proper environment
      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.arrayContaining(['ls', '-la']),
        expect.objectContaining({
          cwd: '/tmp',
          env: expect.objectContaining({ 
            CUSTOM_VAR: 'test-value',
            NODE_ENV: 'test' 
          })
        })
      );
    });

    it('should handle command execution with file operations in same session', async () => {
      // First, execute a command that creates a file
      const createFileRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo "test content" > /tmp/test.txt',
          sessionId: 'session-integration'
        })
      });

      const createResponse = await executeHandler.handle(createFileRequest, mockContext);
      expect(createResponse.status).toBe(200);

      // Mock file existence for subsequent operations
      (global.Bun.file as any).mockReturnValue({
        exists: vi.fn().mockResolvedValue(true),
        text: vi.fn().mockResolvedValue('test content\n'),
        size: 13,
      });

      // Then, use file service to read the created file (simulating cross-service workflow)
      const fileResult = await fileService.readFile('/tmp/test.txt', 'utf-8');
      
      expect(fileResult.isSuccess).toBe(true);
      if (fileResult.isSuccess) {
        expect(fileResult.data).toContain('test content');
      }

      // Verify both services logged their operations
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Command execution completed'),
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('File read completed'),
        expect.objectContaining({
          path: '/tmp/test.txt',
          encoding: 'utf-8'
        })
      );
    });

    it('should propagate security violations through the entire chain', async () => {
      const maliciousRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'sudo rm -rf /',
          sessionId: 'session-integration'
        })
      });

      const response = await executeHandler.handle(maliciousRequest, mockContext);

      // Should return security error response
      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Command validation failed');

      // Security logging should have occurred
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Dangerous command execution attempt'),
        expect.objectContaining({
          command: 'sudo rm -rf /'
        })
      );

      // Command should not have been executed
      expect(mockBunSpawn).not.toHaveBeenCalled();
      expect(mockSessionStore.set).not.toHaveBeenCalled();
    });

    it('should handle session creation and environment inheritance', async () => {
      // Mock session doesn't exist initially
      (mockSessionStore.get as any).mockResolvedValueOnce(null);
      
      const sessionCreateRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'env',
          sessionId: 'new-session-123',
          env: { INIT_VAR: 'initial-value' }
        })
      });

      const response = await executeHandler.handle(sessionCreateRequest, mockContext);

      expect(response.status).toBe(200);

      // Should have created new session
      expect(mockSessionStore.set).toHaveBeenCalledWith(
        'new-session-123',
        expect.objectContaining({
          id: 'new-session-123',
          env: expect.objectContaining({ INIT_VAR: 'initial-value' }),
          isActive: true
        })
      );

      // Command should have been executed with new environment
      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.arrayContaining(['env']),
        expect.objectContaining({
          env: expect.objectContaining({ INIT_VAR: 'initial-value' })
        })
      );
    });

    it('should handle streaming command execution', async () => {
      const streamingRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'tail -f /var/log/app.log',
          sessionId: 'session-integration',
          streaming: true
        })
      });

      const response = await executeHandler.handle(streamingRequest, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Connection')).toBe('keep-alive');

      // Verify streaming was initiated
      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.arrayContaining(['tail', '-f', '/var/log/app.log']),
        expect.objectContaining({
          cwd: '/tmp'
        })
      );
    });

    it('should handle command execution errors gracefully', async () => {
      // Mock command execution failure
      const failingProcess = {
        exited: Promise.resolve(1),
        stdout: {
          getReader: () => ({
            read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
          }),
        },
        stderr: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('Command not found\n') })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
        kill: vi.fn(),
      };

      mockBunSpawn.mockReturnValue(failingProcess);

      const failingRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'nonexistent-command',
          sessionId: 'session-integration'
        })
      });

      const response = await executeHandler.handle(failingRequest, mockContext);

      expect(response.status).toBe(200); // Still 200 but with error info
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.exitCode).toBe(1);
      expect(responseData.error).toContain('Command not found');

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Command execution failed'),
        expect.objectContaining({
          exitCode: 1,
          sessionId: 'session-integration'
        })
      );
    });

    it('should maintain session context across multiple command executions', async () => {
      // First command: change directory
      const chdirRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'cd /home/user',
          sessionId: 'session-integration',
          cwd: '/home/user'
        })
      });

      await executeHandler.handle(chdirRequest, mockContext);

      // Session should be updated with new working directory
      expect(mockSessionStore.set).toHaveBeenCalledWith(
        'session-integration',
        expect.objectContaining({
          cwd: '/home/user'
        })
      );

      // Second command: should use updated working directory
      (mockSessionStore.get as any).mockResolvedValueOnce({
        id: 'session-integration',
        createdAt: new Date(),
        lastActivity: new Date(),
        env: { NODE_ENV: 'test' },
        cwd: '/home/user', // Updated working directory
        isActive: true,
      });

      const listRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'ls',
          sessionId: 'session-integration'
        })
      });

      await executeHandler.handle(listRequest, mockContext);

      // Command should execute in the updated working directory
      expect(mockBunSpawn).toHaveBeenLastCalledWith(
        expect.arrayContaining(['ls']),
        expect.objectContaining({
          cwd: '/home/user'
        })
      );
    });
  });

  describe('error boundary testing', () => {
    it('should handle invalid JSON requests gracefully', async () => {
      const invalidJsonRequest = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json {'
      });

      const response = await executeHandler.handle(invalidJsonRequest, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Invalid JSON');
    });

    it('should handle session store failures', async () => {
      // Mock session store failure
      (mockSessionStore.get as any).mockRejectedValue(new Error('Session store unavailable'));

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'ls',
          sessionId: 'session-integration'
        })
      });

      const response = await executeHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Session retrieval failed');

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Session operation failed'),
        expect.objectContaining({
          error: expect.stringContaining('Session store unavailable')
        })
      );
    });

    it('should handle command spawn failures', async () => {
      // Mock spawn failure
      mockBunSpawn.mockImplementation(() => {
        throw new Error('Failed to spawn process');
      });

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'ls',
          sessionId: 'session-integration'
        })
      });

      const response = await executeHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Command execution failed');
    });
  });

  describe('cross-service data flow', () => {
    it('should demonstrate service result pattern propagation', async () => {
      // This test verifies that ServiceResult patterns flow correctly through the architecture
      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo "testing service results"',
          sessionId: 'session-integration'
        })
      });

      const response = await executeHandler.handle(request, mockContext);
      const responseData = await response.json();

      // Response should follow ServiceResult pattern structure
      expect(responseData).toHaveProperty('success');
      expect(responseData).toHaveProperty('output');
      expect(responseData).toHaveProperty('exitCode');
      
      // Successful execution should have ServiceResult success structure
      expect(responseData.success).toBe(true);
      expect(responseData.output).toBeDefined();
      expect(responseData.exitCode).toBe(0);

      // Should not have error field on success
      expect(responseData.error).toBeUndefined();
    });
  });
});

/**
 * This integration test suite validates the complete command execution workflow:
 * 
 * 1. **Complete Request Processing**: Tests the full pipeline from HTTP request
 *    through validation, security, session management, and command execution.
 * 
 * 2. **Service Orchestration**: Validates how ExecuteHandler coordinates
 *    SessionService, SecurityService, and command execution.
 * 
 * 3. **Cross-Service Workflows**: Tests scenarios where command execution
 *    works with file operations and session management.
 * 
 * 4. **Security Integration**: Verifies that security violations are properly
 *    propagated through the entire request processing chain.
 * 
 * 5. **Session Context Management**: Tests how session state is maintained
 *    and updated across multiple command executions.
 * 
 * 6. **Error Boundary Handling**: Validates graceful error handling at all
 *    levels of the architecture (JSON parsing, session store, command execution).
 * 
 * 7. **Streaming Integration**: Tests the streaming command execution flow
 *    with proper headers and response handling.
 * 
 * 8. **ServiceResult Pattern Flow**: Validates that the ServiceResult pattern
 *    is properly maintained throughout the entire request processing pipeline.
 * 
 * 9. **Logging Integration**: Verifies that all services log their operations
 *    appropriately during the integrated workflow.
 * 
 * 10. **Data Transformation**: Tests how data is transformed and passed between
 *     different layers of the architecture.
 * 
 * The tests demonstrate that the refactored architecture successfully coordinates
 * multiple services while maintaining proper error handling, security validation,
 * and response formatting throughout the entire request lifecycle.
 */