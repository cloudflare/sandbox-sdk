import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '../../sandbox';

/**
 * Container Error Response Tests
 * 
 * Validates that container endpoints return structured error responses
 * in the format expected by our client error mapping system.
 * This ensures consistency between container errors and client error classes.
 * 
 * ✅ STORAGE ISOLATION: Proper resource management implemented
 */
describe('Container Error Response Format', () => {
  let sandboxId: DurableObjectId;
  let sandboxStub: DurableObjectStub;

  beforeAll(async () => {
    sandboxId = env.Sandbox.newUniqueId();
    sandboxStub = env.Sandbox.get(sandboxId);
  });

  afterEach(async () => {
    // Clean up any test-specific resources
  });

  /**
   * Helper function to wait for container readiness
   * Improved version with better error handling and resource management
   */
  async function waitForContainerReady(instance: Sandbox): Promise<void> {
    for (let i = 0; i < 15; i++) {
      try {
        if (!instance.ctx.container.running) {
          await instance.ctx.container.start();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const port = instance.ctx.container.getTcpPort(3000);
        const response = await port.fetch('http://container/api/ping', {
          signal: AbortSignal.timeout(5000)
        });
        
        if (response.status === 200) {
          // Consume response body to avoid resource leaks
          await response.text();
          return;
        }
      } catch (error) {
        // Continue waiting
      }
      
      const waitTime = Math.min(1000 + (i * 200), 3000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    throw new Error('Container failed to become ready');
  }

  describe('File Operation Errors', () => {
    it('should return FILE_NOT_FOUND error for missing files', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/tmp/does-not-exist.txt'
          })
        });
      });

      expect(response.status).toBe(404);
      
      const errorData = await response.json();
      
      // Validate error structure matches our error mapping expectations
      expect(errorData).toHaveProperty('error');
      expect(errorData).toHaveProperty('code');
      expect(errorData.code).toBe('FILE_NOT_FOUND');
      
      // Check for optional error context fields
      if (errorData.path) {
        expect(errorData.path).toBe('/tmp/does-not-exist.txt');
      }
      if (errorData.operation) {
        expect(errorData.operation).toBe('READ_FILE');
      }
    });

    it('should return PERMISSION_DENIED error for restricted file access', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/root/.ssh/id_rsa' // Typically restricted file
          })
        });
      });

      // Should return an error (exact status may vary)
      expect(response.status).toBeGreaterThanOrEqual(400);
      
      const errorData = await response.json();
      expect(errorData).toHaveProperty('error');
      expect(errorData).toHaveProperty('code');
      
      // Should be either FILE_NOT_FOUND or PERMISSION_DENIED
      expect(['FILE_NOT_FOUND', 'PERMISSION_DENIED']).toContain(errorData.code);
    });

    it('should return proper error structure for write operations', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/invalid/path/that/does/not/exist/file.txt',
            content: 'test content'
          })
        });
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      
      const errorData = await response.json();
      expect(errorData).toHaveProperty('error');
      expect(errorData).toHaveProperty('code');
      
      // Should indicate path or directory issue
      expect(['FILE_NOT_FOUND', 'DIRECTORY_NOT_FOUND', 'PERMISSION_DENIED']).toContain(errorData.code);
    });
  });

  describe('Command Execution Errors', () => {
    it('should return COMMAND_NOT_FOUND for invalid commands', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'nonexistent-command-12345'
          })
        });
      });

      // Command not found might return success=false with exitCode != 0
      // OR it might return an error response
      const data = await response.json();
      
      if (response.status >= 400) {
        // Error response format
        expect(data).toHaveProperty('error');
        expect(data).toHaveProperty('code');
        expect(data.code).toBe('COMMAND_NOT_FOUND');
      } else {
        // Success response but with failure indicated
        expect(data.success).toBe(false);
        expect(data.exitCode).not.toBe(0);
        expect(data.stderr).toContain('not found');
      }
    });

    it('should handle malformed command requests', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Missing required 'command' field
            invalidField: 'test'
          })
        });
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      
      const errorData = await response.json();
      expect(errorData).toHaveProperty('error');
      
      // Should indicate validation or bad request
      if (errorData.code) {
        expect(['VALIDATION_ERROR', 'BAD_REQUEST']).toContain(errorData.code);
      }
    });
  });

  describe('Process Management Errors', () => {
    it('should return PROCESS_NOT_FOUND for missing processes', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/process/nonexistent-process-id');
      });

      expect(response.status).toBe(404);
      
      const errorData = await response.json();
      expect(errorData).toHaveProperty('error');
      expect(errorData).toHaveProperty('code');
      expect(errorData.code).toBe('PROCESS_NOT_FOUND');
      
      if (errorData.processId) {
        expect(errorData.processId).toBe('nonexistent-process-id');
      }
    });

    it('should handle process operation errors properly', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        
        // Try to kill a non-existent process
        return await port.fetch('http://container/api/process/fake-process-id', {
          method: 'DELETE'
        });
      });

      expect(response.status).toBe(404);
      
      const errorData = await response.json();
      expect(errorData).toHaveProperty('error');
      expect(errorData).toHaveProperty('code');
      expect(errorData.code).toBe('PROCESS_NOT_FOUND');
    });
  });

  describe('Port Management Errors', () => {
    it('should return PORT_ALREADY_EXPOSED for duplicate port exposure', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        
        // Expose port first time
        const firstResponse = await port.fetch('http://container/api/expose-port', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: 8080
          })
        });
        
        // Try to expose same port again
        const secondResponse = await port.fetch('http://container/api/expose-port', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: 8080
          })
        });
        
        return {
          first: await firstResponse.json(),
          second: {
            status: secondResponse.status,
            data: await secondResponse.json()
          }
        };
      });

      // First exposure should succeed
      expect(result.first.success).toBe(true);
      
      // Second exposure should fail
      expect(result.second.status).toBeGreaterThanOrEqual(400);
      expect(result.second.data).toHaveProperty('error');
      expect(result.second.data).toHaveProperty('code');
      expect(result.second.data.code).toBe('PORT_ALREADY_EXPOSED');
      
      if (result.second.data.port) {
        expect(result.second.data.port).toBe(8080);
      }
    });

    it('should return proper error for invalid port numbers', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/expose-port', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: 99999 // Invalid port number
          })
        });
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      
      const errorData = await response.json();
      expect(errorData).toHaveProperty('error');
      expect(errorData).toHaveProperty('code');
      expect(['INVALID_PORT', 'VALIDATION_ERROR']).toContain(errorData.code);
    });
  });

  describe('Error Response Structure Validation', () => {
    it('should include all required error fields', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/nonexistent/file.txt'
          })
        });
      });

      expect(response.status).toBe(404);
      
      const errorData = await response.json();
      
      // Required fields
      expect(errorData).toHaveProperty('error');
      expect(errorData).toHaveProperty('code');
      expect(typeof errorData.error).toBe('string');
      expect(typeof errorData.code).toBe('string');
      
      // Optional but recommended fields
      const allowedOptionalFields = [
        'operation', 'path', 'port', 'processId', 'command', 
        'details', 'httpStatus', 'timestamp'
      ];
      
      // Check that any extra fields are from the allowed list
      for (const field of Object.keys(errorData)) {
        if (!['error', 'code'].includes(field)) {
          expect(allowedOptionalFields).toContain(field);
        }
      }
    });

    it('should have consistent HTTP status codes', async () => {
      const testCases = [
        {
          endpoint: '/api/read',
          body: { path: '/nonexistent/file.txt' },
          expectedStatus: 404,
          expectedCode: 'FILE_NOT_FOUND'
        },
        {
          endpoint: '/api/process/fake-id',
          method: 'GET',
          expectedStatus: 404,
          expectedCode: 'PROCESS_NOT_FOUND'
        }
      ];

      for (const testCase of testCases) {
        const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
          await waitForContainerReady(instance);
          
          const port = instance.ctx.container.getTcpPort(3000);
          return await port.fetch(`http://container${testCase.endpoint}`, {
            method: testCase.method || 'POST',
            headers: { 'Content-Type': 'application/json' },
            ...(testCase.body && { body: JSON.stringify(testCase.body) })
          });
        });

        expect(response.status).toBe(testCase.expectedStatus);
        
        const errorData = await response.json();
        expect(errorData.code).toBe(testCase.expectedCode);
      }
    });
  });
});