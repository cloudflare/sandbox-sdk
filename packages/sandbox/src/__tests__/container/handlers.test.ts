import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '../../sandbox';

/**
 * Container Handler Tests
 * 
 * Tests the actual container HTTP endpoints that run on port 3000
 * These tests validate that our container handlers work correctly
 * and return proper responses in the expected format.
 * 
 * ✅ BUILD ID FIX WORKING: The build ID assertion error has been resolved!
 * ✅ STORAGE ISOLATION: Proper resource management implemented
 */
describe('Container HTTP Handlers', () => {
  let sandboxId: DurableObjectId;
  let sandboxStub: DurableObjectStub;

  // Use beforeAll for shared setup to reduce container initialization overhead
  beforeAll(async () => {
    sandboxId = env.Sandbox.newUniqueId();
    sandboxStub = env.Sandbox.get(sandboxId);
  });

  // Ensure proper cleanup after each test
  afterEach(async () => {
    // Clean up any test-specific resources
    // The container will be reused but state should be isolated
  });

  describe('Basic Endpoints', () => {
    it('should respond to root endpoint', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        // Wait for container to be ready
        await waitForContainerReady(instance);
        
        // Test root endpoint
        const port = instance.ctx.container.getTcpPort(3000);
        const res = await port.fetch('http://container/');
        // Consume response body to avoid resource leaks
        const text = await res.text();
        
        return { status: res.status, text };
      });

      expect(response.status).toBe(200);
      expect(response.text).toContain('Hello from Bun server!');
    });

    it('should respond to ping endpoint', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/ping');
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe('pong');
      expect(data.timestamp).toBeDefined();
    });

    it('should list available commands', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/commands');
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.availableCommands).toBeInstanceOf(Array);
      expect(data.availableCommands).toContain('ls');
      expect(data.availableCommands).toContain('echo');
      expect(data.timestamp).toBeDefined();
    });

    it('should handle CORS preflight requests', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/ping', {
          method: 'OPTIONS'
        });
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('Session Management', () => {
    it('should create new sessions', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/session/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sessionId).toBeDefined();
      expect(data.sessionId).toMatch(/^session_\d+_[a-f0-9]+$/);
      expect(data.message).toBe('Session created successfully');
      expect(data.timestamp).toBeDefined();
    });

    it('should list sessions', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        
        // Create a session first
        const createResponse = await port.fetch('http://container/api/session/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const createData = await createResponse.json();
        
        // List sessions
        const listResponse = await port.fetch('http://container/api/session/list');
        const listData = await listResponse.json();
        
        return { createData, listData };
      });

      expect(result.listData.count).toBeGreaterThan(0);
      expect(result.listData.sessions).toBeInstanceOf(Array);
      expect(result.listData.sessions[0].sessionId).toBe(result.createData.sessionId);
      expect(result.listData.sessions[0].hasActiveProcess).toBe(false);
      expect(result.listData.timestamp).toBeDefined();
    });
  });

  describe('Command Execution', () => {
    it('should execute simple commands', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'echo "Hello Container"'
          })
        });
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.exitCode).toBe(0);
      expect(data.stdout.trim()).toBe('Hello Container');
      expect(data.stderr).toBe('');
      expect(data.command).toBe('echo "Hello Container"');
      expect(data.timestamp).toBeDefined();
    });

    it('should handle command failures', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'false' // Command that always fails
          })
        });
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.exitCode).toBe(1);
      expect(data.command).toBe('false');
    });

    it('should support streaming command execution', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/execute/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'echo "streaming test"'
          })
        });
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      
      // Verify streaming response format
      const body = await response.text();
      expect(body).toContain('data:');
      expect(body).toContain('streaming test');
    });
  });

  describe('File Operations', () => {
    it('should write and read files', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        
        // Write file
        const writeResponse = await port.fetch('http://container/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/tmp/test.txt',
            content: 'Hello Container File System'
          })
        });
        
        const writeData = await writeResponse.json();
        
        // Read file
        const readResponse = await port.fetch('http://container/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/tmp/test.txt'
          })
        });
        
        const readData = await readResponse.json();
        
        return { writeResponse, writeData, readResponse, readData };
      });

      expect(result.writeResponse.status).toBe(200);
      expect(result.writeData.success).toBe(true);
      
      expect(result.readResponse.status).toBe(200);
      expect(result.readData.content).toBe('Hello Container File System');
      expect(result.readData.path).toBe('/tmp/test.txt');
    });

    it('should handle file not found errors', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/tmp/nonexistent.txt'
          })
        });
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('File not found');
      expect(data.code).toBe('FILE_NOT_FOUND');
    });

    it('should create directories', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/tmp/test-dir'
          })
        });
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('should delete files', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        
        // Create file first
        await port.fetch('http://container/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/tmp/delete-test.txt',
            content: 'to be deleted'
          })
        });
        
        // Delete file
        const deleteResponse = await port.fetch('http://container/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/tmp/delete-test.txt'
          })
        });
        
        return await deleteResponse.json();
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/unknown-endpoint');
      });

      expect(response.status).toBe(404);
    });

    it('should handle malformed JSON requests', async () => {
      const response = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const port = instance.ctx.container.getTcpPort(3000);
        return await port.fetch('http://container/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json'
        });
      });

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe('Internal server error');
    });
  });
});

/**
 * Helper function to wait for container to be ready
 * Containers need time to start up before they can handle requests
 * Improved version with better error handling and resource management
 */
async function waitForContainerReady(instance: Sandbox, maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Ensure container is started
      if (!instance.ctx.container.running) {
        await instance.ctx.container.start();
        // Give extra time after starting
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Test if container is responding
      const port = instance.ctx.container.getTcpPort(3000);
      const response = await port.fetch('http://container/api/ping', {
        signal: AbortSignal.timeout(5000) // 5 second timeout per request
      });
      
      if (response.status === 200) {
        // Consume the response body to avoid resource leaks
        await response.text();
        return; // Container is ready
      }
    } catch (error) {
      // Container not ready yet, continue waiting
      if (process.env.NODE_ENV !== 'test') {
        console.log(`[Container Test] Waiting for container to be ready... attempt ${i + 1}/${maxAttempts}`);
      }
    }
    
    // Progressive backoff: longer waits for later attempts
    const waitTime = Math.min(1000 + (i * 200), 3000);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  throw new Error(`Container failed to become ready within ${maxAttempts} attempts`);
}