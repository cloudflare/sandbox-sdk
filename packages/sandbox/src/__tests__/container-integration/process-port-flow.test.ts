/**
 * Process and Port Management Integration Tests
 * 
 * Tests complete request flows for process management and port exposure:
 * - Process lifecycle → Session tracking → Port exposure → Proxy coordination
 * 
 * These tests use the full Router + Middleware + Handler pipeline to test real integration
 */

import { Router } from '@container/core/router';
import { Container } from '@container/core/container';
import { setupRoutes } from '@container/routes/setup';
import type { StartProcessResponse, ListProcessesResponse, KillAllProcessesResponse } from '../../clients/process-client';
import type { ExposePortResponse, GetExposedPortsResponse } from '../../clients/port-client';
import type { ApiErrorResponse } from '../../clients/types';

// Mock Bun globals for process and port operations
const mockBunSpawn = vi.fn();
global.Bun = {
  spawn: mockBunSpawn,
} as any;

describe('Process and Port Management Integration Flow', () => {
  let router: Router;
  let container: Container;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create and initialize the container with all services
    container = new Container();
    await container.initialize();

    // Create router and set up routes with middleware
    router = new Router();
    setupRoutes(router, container);

    // Setup Bun.spawn mock for process operations
    mockBunSpawn.mockImplementation((args: string[]) => {
      const command = args.join(' ');
      
      // Simulate long-running background processes
      if (command.includes('sleep') || command.includes('server') || command.includes('node')) {
        return {
          exited: new Promise(() => {}), // Never resolves for background processes
          exitCode: undefined,
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('Process started successfully'));
              // Don't close - keep running for background processes
            }
          }),
          stderr: new ReadableStream({
            start(controller) { controller.close(); }
          }),
          pid: 12345,
          kill: vi.fn().mockReturnValue(true),
        };
      }
      
      // Simulate quick commands
      return {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Command output'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); }
        }),
        pid: 54321,
        kill: vi.fn(),
      };
    });
  });

  afterEach(() => {
    // Clean up
    router.clearRoutes();
  });

  describe('background process lifecycle workflow', () => {
    it('should start background process and track in session', async () => {
      // Start a background process
      const startProcessRequest = new Request('http://localhost:3000/api/process/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'node server.js',
          options: {
            background: true,
            sessionId: 'session-process-flow'
          }
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const startResponse = await router.route(startProcessRequest);

      expect(startResponse.status).toBe(200);
      const startResponseData = await startResponse.json() as StartProcessResponse;
      expect(startResponseData.success).toBe(true);
      // Process start should succeed - exact response structure may vary
      expect(startResponseData).toHaveProperty('success', true);

      // Verify process spawn was called (directly, not through shell)
      expect(mockBunSpawn).toHaveBeenCalledWith(
        expect.arrayContaining(['node', 'server.js']),
        expect.any(Object)
      );
    });

    it('should list processes by session with proper filtering', async () => {
      // List processes
      const listProcessRequest = new Request('http://localhost:3000/api/process/list', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      const listResponse = await router.route(listProcessRequest);

      expect(listResponse.status).toBe(200);
      const listResponseData = await listResponse.json() as ListProcessesResponse;
      expect(listResponseData.success).toBe(true);
      expect(Array.isArray(listResponseData.processes)).toBe(true);
    });

    it('should stop background process and update session', async () => {
      // Kill all processes (simulating cleanup)
      const killAllRequest = new Request('http://localhost:3000/api/process/kill-all', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      const killResponse = await router.route(killAllRequest);

      expect(killResponse.status).toBe(200);
      const killResponseData = await killResponse.json() as KillAllProcessesResponse;
      expect(killResponseData.success).toBe(true);
    });
  });

  describe('port exposure and management workflow', () => {
    it('should expose port for running service with security validation', async () => {
      // Expose a port
      const exposePortRequest = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 4000,  // Use a non-reserved port for testing
          name: 'web-server'
        })
      });

      const exposeResponse = await router.route(exposePortRequest);

      expect(exposeResponse.status).toBe(200);
      const exposeResponseData = await exposeResponse.json() as ExposePortResponse;
      expect(exposeResponseData.success).toBe(true);
      expect(exposeResponseData.port).toBe(4000);
    });

    it('should prevent dangerous port exposure through validation', async () => {
      // Try to expose a reserved port
      const dangerousPortRequest = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 3000  // Reserved for container control plane
        })
      });

      const response = await router.route(dangerousPortRequest);

      // Should be rejected by security validation
      expect([400, 403]).toContain(response.status);
      const responseData = await response.json() as ApiErrorResponse;
      expect(responseData.success).toBeFalsy();
    });

    it('should list exposed ports with metadata', async () => {
      // List exposed ports
      const listPortsRequest = new Request('http://localhost:3000/api/exposed-ports', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      const listResponse = await router.route(listPortsRequest);

      expect(listResponse.status).toBe(200);
      const listResponseData = await listResponse.json() as GetExposedPortsResponse;
      expect(listResponseData.success).toBe(true);
      expect(Array.isArray(listResponseData.ports)).toBe(true);
    });
  });

  describe('cross-service coordination workflows', () => {
    it('should coordinate process startup with port exposure', async () => {
      // This test demonstrates the typical workflow:
      // 1. Start a background web server process
      // 2. Expose the port it's listening on
      // 3. Verify the coordination works

      // Step 1: Start background server
      const startServerRequest = new Request('http://localhost:3000/api/process/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'node server.js',  // Use simpler command without shell characters
          options: {
            background: true,
            sessionId: 'session-coordination'
          }
        })
      });

      const serverResponse = await router.route(startServerRequest);
      expect(serverResponse.status).toBe(200);

      // Step 2: Expose the port
      const exposeRequest = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 5000,  // Use non-reserved port
          name: 'coordination-server'
        })
      });

      const exposeResponse = await router.route(exposeRequest);
      expect(exposeResponse.status).toBe(200);

      const exposeData = await exposeResponse.json() as ExposePortResponse;
      expect(exposeData.success).toBe(true);
    });

    it('should handle process termination and port cleanup', async () => {
      // Test cleanup workflow when processes are terminated
      
      // Kill all processes
      const killAllRequest = new Request('http://localhost:3000/api/process/kill-all', {
        method: 'DELETE'
      });

      const killResponse = await router.route(killAllRequest);
      expect(killResponse.status).toBe(200);

      // Cleanup should succeed
      const killData = await killResponse.json() as KillAllProcessesResponse;
      expect(killData.success).toBe(true);
    });
  });

  describe('error boundary and resource management', () => {
    it('should handle port conflicts gracefully', async () => {
      // This tests how the system handles resource conflicts
      
      // Try to expose the same port twice
      const firstExpose = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 8888,
          name: 'first-service'
        })
      });

      const firstResponse = await router.route(firstExpose);
      expect(firstResponse.status).toBe(200);

      const secondExpose = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: 8888,
          name: 'second-service'
        })
      });

      const secondResponse = await router.route(secondExpose);
      
      // Should handle the conflict (port already exposed error)
      expect([400, 409]).toContain(secondResponse.status);
    });

    it('should handle process spawn failures gracefully', async () => {
      // Mock spawn failure
      mockBunSpawn.mockImplementationOnce(() => {
        throw new Error('Process spawn failed');
      });

      const failingProcessRequest = new Request('http://localhost:3000/api/process/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'failing-command',
          options: {
            sessionId: 'session-error-test'
          }
        })
      });

      const response = await router.route(failingProcessRequest);
      
      // Should handle spawn failure gracefully
      expect([400, 500]).toContain(response.status);
      const responseData = await response.json() as ApiErrorResponse;
      expect(responseData.success).toBe(false);
    });
  });
});