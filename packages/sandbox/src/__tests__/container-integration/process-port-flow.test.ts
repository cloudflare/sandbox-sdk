/**
 * Process and Port Management Integration Tests
 * 
 * Tests complete request flows for process management and port exposure:
 * - Process lifecycle → Session tracking → Port exposure → Proxy coordination
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { 
  ProcessHandler,
  PortHandler,
  SessionService,
  SecurityService,
  ProcessService,
  PortService,
  Logger,
  RequestContext,
  SessionStore,
  ProcessStore,
  PortStore
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

const mockProcessStore: ProcessStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  findBySessionId: vi.fn(),
};

const mockPortStore: PortStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  findByPort: vi.fn(),
  listBySessionId: vi.fn(),
};

// Mock Bun globals for process management
const mockBunSpawn = vi.fn();
global.Bun = {
  spawn: mockBunSpawn,
  file: vi.fn(),
} as any;

// Mock fetch for port proxying
global.fetch = vi.fn();

const mockContext: RequestContext = {
  requestId: 'req-process-port-789',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-process-port',
  validatedData: {},
};

describe('Process and Port Management Integration Flow', () => {
  let processHandler: ProcessHandler;
  let portHandler: PortHandler;
  let sessionService: SessionService;
  let securityService: SecurityService;
  let processService: ProcessService;
  let portService: PortService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import and create service instances
    const { SessionService: SessionServiceClass } = await import('@container/services/session-service');
    const { SecurityService: SecurityServiceClass } = await import('@container/security/security-service');
    const { ProcessService: ProcessServiceClass } = await import('@container/services/process-service');
    const { PortService: PortServiceClass } = await import('@container/services/port-service');
    const { ProcessHandler: ProcessHandlerClass } = await import('@container/handlers/process-handler');
    const { PortHandler: PortHandlerClass } = await import('@container/handlers/port-handler');

    // Create integrated service chain
    securityService = new SecurityServiceClass(mockLogger);
    sessionService = new SessionServiceClass(mockSessionStore, mockLogger);
    processService = new ProcessServiceClass(mockProcessStore, mockLogger);
    portService = new PortServiceClass(mockPortStore, mockLogger);
    processHandler = new ProcessHandlerClass(processService, sessionService, securityService, mockLogger);
    portHandler = new PortHandlerClass(portService, sessionService, mockLogger);

    // Setup default session mock
    (mockSessionStore.get as any).mockResolvedValue({
      id: 'session-process-port',
      createdAt: new Date(),
      lastActivity: new Date(),
      env: { NODE_ENV: 'test' },
      cwd: '/tmp',
      isActive: true,
    });

    (mockSessionStore.set as any).mockResolvedValue(undefined);

    // Setup default process mocks
    (mockProcessStore.set as any).mockResolvedValue(undefined);
    (mockProcessStore.get as any).mockResolvedValue(null);
    (mockProcessStore.findBySessionId as any).mockResolvedValue([]);

    // Setup default port mocks
    (mockPortStore.set as any).mockResolvedValue(undefined);
    (mockPortStore.get as any).mockResolvedValue(null);
    (mockPortStore.findByPort as any).mockResolvedValue(null);
    (mockPortStore.listBySessionId as any).mockResolvedValue([]);

    // Mock successful long-running process
    const mockProcess = {
      exited: Promise.resolve(null), // Still running
      stdout: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('Server started on port 8080\n') })
            .mockResolvedValue({ done: true, value: undefined }),
        }),
      },
      stderr: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
        }),
      },
      kill: vi.fn(),
      pid: 12345,
    };

    mockBunSpawn.mockReturnValue(mockProcess);

    // Mock successful HTTP responses for proxying
    (global.fetch as any).mockResolvedValue(new Response('Hello from proxied service', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    }));
  });

  describe('background process lifecycle workflow', () => {
    it('should start background process and track in session', async () => {
      const startProcessRequest = new Request('http://localhost:3000/api/processes/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'node server.js',
          background: true,
          cwd: '/tmp/app',
          env: { PORT: '8080' },
          sessionId: 'session-process-port'
        })
      });

      const response = await processHandler.handle(startProcessRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.processId).toBeDefined();
      expect(responseData.pid).toBe(12345);

      // Verify the complete integration chain
      
      // 1. Process should be spawned with correct parameters
      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['node', 'server.js'],
        expect.objectContaining({
          cwd: '/tmp/app',
          env: expect.objectContaining({ PORT: '8080' })
        })
      );

      // 2. Process should be stored for tracking
      expect(mockProcessStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          command: 'node server.js',
          pid: 12345,
          sessionId: 'session-process-port',
          isBackground: true,
          status: 'running'
        })
      );

      // 3. Session should be updated with active process
      expect(mockSessionStore.set).toHaveBeenCalledWith(
        'session-process-port',
        expect.objectContaining({
          activeProcess: expect.any(String)
        })
      );

      // 4. Process start should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Background process started',
        expect.objectContaining({
          processId: expect.any(String),
          pid: 12345,
          sessionId: 'session-process-port'
        })
      );
    });

    it('should list processes by session with proper filtering', async () => {
      // Mock existing processes for the session
      (mockProcessStore.findBySessionId as any).mockResolvedValue([
        {
          id: 'proc-1',
          command: 'node server.js',
          pid: 12345,
          sessionId: 'session-process-port',
          status: 'running',
          createdAt: new Date(),
        },
        {
          id: 'proc-2',
          command: 'npm run dev',
          pid: 12346,
          sessionId: 'session-process-port',
          status: 'completed',
          exitCode: 0,
          createdAt: new Date(),
        }
      ]);

      const listRequest = new Request('http://localhost:3000/api/processes?sessionId=session-process-port', {
        method: 'GET'
      });

      const response = await processHandler.handle(listRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.processes).toHaveLength(2);
      expect(responseData.processes[0].status).toBe('running');
      expect(responseData.processes[1].status).toBe('completed');

      // Process listing should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Processes listed',
        expect.objectContaining({
          sessionId: 'session-process-port',
          count: 2
        })
      );
    });

    it('should stop background process and update session', async () => {
      // Mock existing process
      (mockProcessStore.get as any).mockResolvedValue({
        id: 'proc-123',
        command: 'node server.js',
        pid: 12345,
        sessionId: 'session-process-port',
        status: 'running',
        bunProcess: {
          kill: vi.fn(),
          exited: Promise.resolve(0)
        }
      });

      const stopRequest = new Request('http://localhost:3000/api/processes/proc-123/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session-process-port'
        })
      });

      const response = await processHandler.handle(stopRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.message).toContain('stopped');

      // Process should be updated in store
      expect(mockProcessStore.set).toHaveBeenCalledWith(
        'proc-123',
        expect.objectContaining({
          status: 'stopped',
          exitCode: 0
        })
      );

      // Process stop should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Process stopped',
        expect.objectContaining({
          processId: 'proc-123',
          exitCode: 0
        })
      );
    });
  });

  describe('port exposure and proxy workflow', () => {
    it('should expose port with security validation and session tracking', async () => {
      const exposePortRequest = new Request('http://localhost:3000/api/ports/expose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 8080,
          name: 'web-server',
          sessionId: 'session-process-port'
        })
      });

      const response = await portHandler.handle(exposePortRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.port).toBe(8080);
      expect(responseData.previewUrl).toBeDefined();
      expect(responseData.previewUrl).toContain('8080');

      // Verify the complete integration chain

      // 1. Port should be stored with session association
      expect(mockPortStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          port: 8080,
          name: 'web-server',
          sessionId: 'session-process-port',
          isActive: true
        })
      );

      // 2. Session should be updated
      expect(mockSessionStore.set).toHaveBeenCalled();

      // 3. Port exposure should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Port exposed',
        expect.objectContaining({
          port: 8080,
          name: 'web-server',
          sessionId: 'session-process-port'
        })
      );
    });

    it('should prevent exposing reserved ports through security integration', async () => {
      const dangerousPortRequest = new Request('http://localhost:3000/api/ports/expose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 22, // SSH port - should be blocked
          sessionId: 'session-process-port'
        })
      });

      const response = await portHandler.handle(dangerousPortRequest, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Port validation failed');

      // Security violation should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Port validation failed',
        expect.objectContaining({
          port: 22
        })
      );

      // Port should not have been stored
      expect(mockPortStore.set).not.toHaveBeenCalled();
    });

    it('should proxy requests to exposed ports', async () => {
      // Mock existing port
      (mockPortStore.findByPort as any).mockResolvedValue({
        id: 'port-123',
        port: 8080,
        name: 'web-server',
        sessionId: 'session-process-port',
        isActive: true,
        previewUrl: 'https://preview.example.com/session-process-port-8080'
      });

      const proxyRequest = new Request('http://localhost:3000/api/ports/8080/proxy/health', {
        method: 'GET'
      });

      const response = await portHandler.handle(proxyRequest, mockContext);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Hello from proxied service');

      // Proxy request should be made to local service
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/health',
        expect.objectContaining({
          method: 'GET'
        })
      );

      // Proxy request should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Port proxy request',
        expect.objectContaining({
          port: 8080,
          path: '/health'
        })
      );
    });

    it('should list exposed ports by session', async () => {
      // Mock existing ports for the session
      (mockPortStore.listBySessionId as any).mockResolvedValue([
        {
          id: 'port-1',
          port: 8080,
          name: 'web-server',
          sessionId: 'session-process-port',
          isActive: true,
          previewUrl: 'https://preview.example.com/session-process-port-8080'
        },
        {
          id: 'port-2',
          port: 9000,
          name: 'api-server',
          sessionId: 'session-process-port',
          isActive: true,
          previewUrl: 'https://preview.example.com/session-process-port-9000'
        }
      ]);

      const listRequest = new Request('http://localhost:3000/api/ports?sessionId=session-process-port', {
        method: 'GET'
      });

      const response = await portHandler.handle(listRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.ports).toHaveLength(2);
      expect(responseData.ports[0].port).toBe(8080);
      expect(responseData.ports[1].port).toBe(9000);

      // Port listing should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Ports listed',
        expect.objectContaining({
          sessionId: 'session-process-port',
          count: 2
        })
      );
    });
  });

  describe('integrated process and port workflow', () => {
    it('should start web server process and automatically expose port', async () => {
      // 1. Start a web server process
      const startProcessRequest = new Request('http://localhost:3000/api/processes/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'node express-server.js',
          background: true,
          env: { PORT: '8080' },
          sessionId: 'session-process-port'
        })
      });

      const processResponse = await processHandler.handle(startProcessRequest, mockContext);
      expect(processResponse.status).toBe(200);

      const processData = await processResponse.json();
      const processId = processData.processId;

      // 2. Expose the port that the process is using
      const exposePortRequest = new Request('http://localhost:3000/api/ports/expose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 8080,
          name: 'express-server',
          sessionId: 'session-process-port'
        })
      });

      const portResponse = await portHandler.handle(exposePortRequest, mockContext);
      expect(portResponse.status).toBe(200);

      const portData = await portResponse.json();

      // 3. Verify the integration
      expect(processData.success).toBe(true);
      expect(portData.success).toBe(true);
      expect(portData.port).toBe(8080);
      expect(portData.previewUrl).toBeDefined();

      // Both process and port should be tracked in the same session
      expect(mockProcessStore.set).toHaveBeenCalledWith(
        processId,
        expect.objectContaining({
          sessionId: 'session-process-port'
        })
      );

      expect(mockPortStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          port: 8080,
          sessionId: 'session-process-port'
        })
      );
    });

    it('should handle process termination and port cleanup', async () => {
      // Mock existing process and port
      (mockProcessStore.get as any).mockResolvedValue({
        id: 'proc-123',
        command: 'node server.js',
        pid: 12345,
        sessionId: 'session-process-port',
        status: 'running',
        bunProcess: {
          kill: vi.fn(),
          exited: Promise.resolve(0)
        }
      });

      (mockPortStore.listBySessionId as any).mockResolvedValue([
        {
          id: 'port-123',
          port: 8080,
          sessionId: 'session-process-port',
          isActive: true
        }
      ]);

      // 1. Stop the process
      const stopProcessRequest = new Request('http://localhost:3000/api/processes/proc-123/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session-process-port'
        })
      });

      const stopResponse = await processHandler.handle(stopProcessRequest, mockContext);
      expect(stopResponse.status).toBe(200);

      // 2. List ports to verify they're still tracked
      const listPortsRequest = new Request('http://localhost:3000/api/ports?sessionId=session-process-port', {
        method: 'GET'
      });

      const portsResponse = await portHandler.handle(listPortsRequest, mockContext);
      expect(portsResponse.status).toBe(200);

      const portsData = await portsResponse.json();
      expect(portsData.ports).toHaveLength(1);

      // Process should be stopped but ports should remain exposed
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Process stopped',
        expect.any(Object)
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Ports listed',
        expect.any(Object)
      );
    });

    it('should maintain session context across process and port operations', async () => {
      const operations = [
        {
          handler: processHandler,
          request: new Request('http://localhost:3000/api/processes/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command: 'node api-server.js',
              background: true,
              sessionId: 'session-process-port'
            })
          })
        },
        {
          handler: portHandler,
          request: new Request('http://localhost:3000/api/ports/expose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              port: 3001,
              name: 'api-server',
              sessionId: 'session-process-port'
            })
          })
        }
      ];

      for (const op of operations) {
        const response = await op.handler.handle(op.request, mockContext);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
      }

      // Session should have been accessed and updated for each operation
      expect(mockSessionStore.get).toHaveBeenCalledTimes(2);
      expect(mockSessionStore.set).toHaveBeenCalledTimes(2);

      // All operations should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Background process started',
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Port exposed',
        expect.any(Object)
      );
    });
  });

  describe('error handling and recovery', () => {
    it('should handle process spawn failures gracefully', async () => {
      // Mock spawn failure
      mockBunSpawn.mockImplementation(() => {
        throw new Error('Failed to spawn process');
      });

      const startRequest = new Request('http://localhost:3000/api/processes/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'invalid-command',
          sessionId: 'session-process-port'
        })
      });

      const response = await processHandler.handle(startRequest, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Process start failed');

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Process start failed',
        expect.objectContaining({
          error: expect.stringContaining('Failed to spawn process')
        })
      );
    });

    it('should handle port proxy failures gracefully', async () => {
      // Mock port exists but proxy fails
      (mockPortStore.findByPort as any).mockResolvedValue({
        id: 'port-123',
        port: 8080,
        sessionId: 'session-process-port',
        isActive: true
      });

      // Mock fetch failure
      (global.fetch as any).mockRejectedValue(new Error('Connection refused'));

      const proxyRequest = new Request('http://localhost:3000/api/ports/8080/proxy/health', {
        method: 'GET'
      });

      const response = await portHandler.handle(proxyRequest, mockContext);

      expect(response.status).toBe(502);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Proxy request failed');

      // Proxy error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Port proxy failed',
        expect.objectContaining({
          port: 8080,
          error: expect.stringContaining('Connection refused')
        })
      );
    });

    it('should handle concurrent process starts without conflicts', async () => {
      const concurrentRequests = Array.from({ length: 3 }, (_, i) => 
        new Request('http://localhost:3000/api/processes/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: `node worker-${i}.js`,
            background: true,
            sessionId: 'session-process-port'
          })
        })
      );

      const responses = await Promise.all(
        concurrentRequests.map(req => processHandler.handle(req, mockContext))
      );

      // All processes should start successfully
      for (const response of responses) {
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.processId).toBeDefined();
      }

      // Each process should be stored
      expect(mockProcessStore.set).toHaveBeenCalledTimes(3);
      expect(mockSessionStore.set).toHaveBeenCalledTimes(3);
    });
  });

  describe('service result pattern validation', () => {
    it('should maintain ServiceResult pattern across all process and port operations', async () => {
      const operations = [
        { handler: processHandler, endpoint: '/api/processes/start', method: 'POST', body: { command: 'ls', sessionId: 'session-process-port' } },
        { handler: processHandler, endpoint: '/api/processes', method: 'GET', body: null },
        { handler: portHandler, endpoint: '/api/ports/expose', method: 'POST', body: { port: 9999, sessionId: 'session-process-port' } },
        { handler: portHandler, endpoint: '/api/ports', method: 'GET', body: null },
      ];

      for (const op of operations) {
        const request = new Request(`http://localhost:3000${op.endpoint}`, {
          method: op.method,
          headers: op.body ? { 'Content-Type': 'application/json' } : {},
          body: op.body ? JSON.stringify(op.body) : undefined
        });

        const response = await op.handler.handle(request, mockContext);
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
 * This integration test suite validates the complete process and port management workflow:
 * 
 * 1. **Background Process Lifecycle**: Tests the complete flow of starting, tracking,
 *    listing, and stopping background processes with session integration.
 * 
 * 2. **Port Exposure and Security**: Validates port exposure with security validation,
 *    preventing reserved ports, and proper session tracking.
 * 
 * 3. **HTTP Proxy Integration**: Tests the port proxying functionality that forwards
 *    requests to exposed services with proper error handling.
 * 
 * 4. **Process-Port Coordination**: Validates scenarios where web server processes
 *    are started and their ports are exposed for external access.
 * 
 * 5. **Session Context Management**: Tests how process and port operations maintain
 *    session context and update session state appropriately.
 * 
 * 6. **Service Orchestration**: Validates how ProcessHandler and PortHandler coordinate
 *    with SessionService, SecurityService, and their respective domain services.
 * 
 * 7. **Error Boundary Handling**: Tests graceful handling of process spawn failures,
 *    proxy connection failures, and concurrent operation conflicts.
 * 
 * 8. **Resource Cleanup**: Validates proper cleanup when processes terminate and
 *    how this affects associated port exposures.
 * 
 * 9. **Concurrent Operations**: Tests that multiple processes can be started and
 *    ports exposed concurrently without race conditions or conflicts.
 * 
 * 10. **ServiceResult Pattern**: Ensures consistent ServiceResult pattern usage
 *     across all process and port management operations.
 * 
 * 11. **Security Integration**: Validates that dangerous ports are blocked and
 *     security violations are properly logged throughout the workflow.
 * 
 * 12. **Audit Trail**: Tests that all process and port operations are logged
 *     with appropriate context for monitoring and debugging.
 * 
 * The tests demonstrate that the refactored architecture successfully coordinates
 * complex process lifecycle management and port exposure while maintaining proper
 * security, session context, and error recovery throughout the entire workflow.
 */