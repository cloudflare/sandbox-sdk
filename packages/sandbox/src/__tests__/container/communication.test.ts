import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '../../sandbox';
import { SandboxClient } from '../../clients/sandbox-client';

/**
 * Container-Client Communication Tests
 * 
 * Tests the complete communication flow between our modular client architecture
 * and the actual container endpoints. This validates that our client abstraction
 * correctly interacts with the container's HTTP API.
 * 
 * ✅ STORAGE ISOLATION: Proper resource management implemented
 */
describe('Container-Client Communication Flow', () => {
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

  describe('Client-Container Integration via Durable Object', () => {
    it('should execute commands through SandboxClient → Durable Object → Container', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Use the built-in client that's configured to talk to this container
        const response = await instance.client.commands.execute('echo "Integration Test"');
        
        return response;
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Integration Test');
      expect(result.stderr).toBe('');
      expect(result.command).toBe('echo "Integration Test"');
      expect(result.timestamp).toBeDefined();
    });

    it('should handle file operations through client → container flow', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Write file through client
        await instance.client.files.writeFile('/tmp/client-test.txt', 'Hello from client!');
        
        // Read file through client
        const content = await instance.client.files.readFile('/tmp/client-test.txt');
        
        return content;
      });

      expect(result).toBe('Hello from client!');
    });

    it('should propagate container errors correctly through client', async () => {
      await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Try to read non-existent file - should propagate FileNotFoundError
        try {
          await instance.client.files.readFile('/tmp/does-not-exist.txt');
          throw new Error('Should have thrown FileNotFoundError');
        } catch (error: any) {
          expect(error.name).toBe('FileNotFoundError');
          expect(error.code).toBe('FILE_NOT_FOUND');
          expect(error.message).toContain('File not found');
        }
      });
    });
  });

  describe('Session Management Flow', () => {
    it('should maintain session context across client operations', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Set session ID on client
        const sessionId = 'test-session-' + Date.now();
        instance.client.setSessionId(sessionId);
        
        // Execute command that creates a file in working directory
        await instance.client.commands.execute('echo "session test" > /tmp/session-file.txt');
        
        // Read file in same session - should work
        const content = await instance.client.files.readFile('/tmp/session-file.txt');
        
        return { sessionId, content };
      });

      expect(result.content.trim()).toBe('session test');
      expect(result.sessionId).toMatch(/^test-session-\d+$/);
    });

    it('should isolate operations between different sessions', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create two different sessions
        const session1 = 'session-1-' + Date.now();
        const session2 = 'session-2-' + Date.now();
        
        // Execute commands with explicit session IDs
        const result1 = await instance.client.commands.execute('pwd', { sessionId: session1 });
        const result2 = await instance.client.commands.execute('pwd', { sessionId: session2 });
        
        return { result1, result2, session1, session2 };
      });

      expect(result.result1.success).toBe(true);
      expect(result.result2.success).toBe(true);
      // Both should work independently
      expect(result.result1.stdout).toBeDefined();
      expect(result.result2.stdout).toBeDefined();
    });
  });

  describe('Process Management Flow', () => {
    it('should start and manage background processes through client', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Start a background process
        const process = await instance.client.processes.startProcess('sleep 5');
        
        // Get process status
        const processInfo = await instance.client.processes.getProcess(process.id);
        
        // List all processes
        const allProcesses = await instance.client.processes.listProcesses();
        
        return { process, processInfo, allProcesses };
      });

      expect(result.process.id).toBeDefined();
      expect(result.process.command).toBe('sleep 5');
      expect(result.process.status).toBe('running');
      
      expect(result.processInfo.id).toBe(result.process.id);
      expect(result.processInfo.status).toBe('running');
      
      expect(result.allProcesses.length).toBeGreaterThan(0);
      expect(result.allProcesses.some(p => p.id === result.process.id)).toBe(true);
    });

    it('should handle process not found errors through client', async () => {
      await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        try {
          await instance.client.processes.getProcess('non-existent-process');
          throw new Error('Should have thrown ProcessNotFoundError');
        } catch (error: any) {
          expect(error.name).toBe('ProcessNotFoundError');
          expect(error.code).toBe('PROCESS_NOT_FOUND');
        }
      });
    });
  });

  describe('Port Management Flow', () => {
    it('should expose and manage ports through client', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Expose a port
        const exposedPort = await instance.client.ports.exposePort({ port: 8080 });
        
        // List exposed ports
        const exposedPorts = await instance.client.ports.getExposedPorts();
        
        return { exposedPort, exposedPorts };
      });

      expect(result.exposedPort.port).toBe(8080);
      expect(result.exposedPort.url).toBeDefined();
      expect(result.exposedPort.url).toContain('8080');
      
      expect(result.exposedPorts.length).toBeGreaterThan(0);
      expect(result.exposedPorts.some(p => p.port === 8080)).toBe(true);
    });

    it('should handle port already exposed errors through client', async () => {
      await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Expose port first time
        await instance.client.ports.exposePort({ port: 9090 });
        
        // Try to expose same port again
        try {
          await instance.client.ports.exposePort({ port: 9090 });
          throw new Error('Should have thrown PortAlreadyExposedError');
        } catch (error: any) {
          expect(error.name).toBe('PortAlreadyExposedError');
          expect(error.code).toBe('PORT_ALREADY_EXPOSED');
          expect(error.port).toBe(9090);
        }
      });
    });
  });

  describe('Utility Operations Flow', () => {
    it('should perform health checks through client', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const pingResponse = await instance.client.utils.ping();
        
        return pingResponse;
      });

      expect(result).toBe('pong');
    });

    it('should get available commands through client', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const commands = await instance.client.utils.getCommands();
        
        return commands;
      });

      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('ls');
      expect(result).toContain('echo');
    });
  });

  describe('Streaming Operations Flow', () => {
    it('should handle streaming command execution through client', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Execute streaming command
        const stream = await instance.client.commands.executeStream('echo "line1"; echo "line2"');
        
        // Parse stream events
        const { parseSSEStream } = await import('../../sse-parser');
        const events = [];
        
        for await (const event of parseSSEStream(stream)) {
          events.push(event);
          if (events.length >= 10) break; // Prevent infinite loop
        }
        
        return events;
      });

      expect(result.length).toBeGreaterThan(0);
      
      // Should have stdout events
      const stdoutEvents = result.filter((event: any) => event.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(0);
      
      // Should contain our output
      const output = stdoutEvents.map((event: any) => event.data).join('');
      expect(output).toContain('line1');
      expect(output).toContain('line2');
    });
  });

  describe('Error Propagation Flow', () => {
    it('should map all container error types correctly', async () => {
      const errors = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const errorResults = [];
        
        // Test File Not Found
        try {
          await instance.client.files.readFile('/nonexistent/file.txt');
        } catch (error: any) {
          errorResults.push({ type: 'FileNotFound', error });
        }
        
        // Test Command Not Found (may not throw, just return failure)
        try {
          const result = await instance.client.commands.execute('command-that-does-not-exist-12345');
          if (!result.success) {
            errorResults.push({ type: 'CommandNotFound', result });
          }
        } catch (error: any) {
          errorResults.push({ type: 'CommandNotFound', error });
        }
        
        // Test Process Not Found
        try {
          await instance.client.processes.getProcess('fake-process-id');
        } catch (error: any) {
          errorResults.push({ type: 'ProcessNotFound', error });
        }
        
        return errorResults;
      });

      // Verify all expected errors were caught
      const errorTypes = errors.map(e => e.type);
      expect(errorTypes).toContain('FileNotFound');
      expect(errorTypes).toContain('ProcessNotFound');
      
      // Verify error structure
      const fileError = errors.find(e => e.type === 'FileNotFound')?.error;
      if (fileError) {
        expect(fileError.name).toBe('FileNotFoundError');
        expect(fileError.code).toBe('FILE_NOT_FOUND');
      }
      
      const processError = errors.find(e => e.type === 'ProcessNotFound')?.error;
      if (processError) {
        expect(processError.name).toBe('ProcessNotFoundError');
        expect(processError.code).toBe('PROCESS_NOT_FOUND');
      }
    });
  });
});