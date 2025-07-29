import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '../../sandbox';
import { FileNotFoundError, CommandNotFoundError, ProcessNotFoundError, PortAlreadyExposedError } from '../../errors';

/**
 * End-to-End Error Recovery and Resilience Tests
 * 
 * These tests validate how the system handles various failure scenarios:
 * 1. Command failures and recovery mechanisms
 * 2. Process crashes and restart procedures
 * 3. Port conflicts and resolution strategies
 * 4. File system errors and cleanup
 * 5. Network failures and retry logic
 * 
 * Tests demonstrate real-world error scenarios and validate
 * that the system remains stable and recoverable.
 */
describe('Error Recovery and Resilience', () => {
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
   */
  async function waitForContainerReady(instance: Sandbox, maxAttempts = 20): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (!instance.ctx.container.running) {
          await instance.ctx.container.start();
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        const port = instance.ctx.container.getTcpPort(3000);
        const response = await port.fetch('http://container/api/ping', {
          signal: AbortSignal.timeout(8000)
        });
        
        if (response.status === 200) {
          await response.text();
          return;
        }
      } catch (error) {
        // Continue waiting
      }
      
      const waitTime = Math.min(1500 + (i * 300), 5000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    throw new Error(`Container failed to become ready within ${maxAttempts} attempts`);
  }

  describe('Command Failure Recovery', () => {
    it('should handle command failures gracefully and allow recovery', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Step 1: Execute a failing command
        const failedResult = await instance.client.commands.execute('nonexistent-command-12345');
        
        // Step 2: Verify system is still functional after failure
        const healthCheck = await instance.client.utils.ping();
        
        // Step 3: Execute a successful command to verify recovery
        const successResult = await instance.client.commands.execute('echo "Recovery successful"');
        
        // Step 4: Try multiple operations to ensure stability
        await instance.client.files.writeFile('/tmp/recovery-test.txt', 'System recovered');
        const fileContent = await instance.client.files.readFile('/tmp/recovery-test.txt');
        
        return {
          failedResult,
          healthAfterFailure: healthCheck,
          successResult,
          fileContent
        };
      });

      // Validate failure was handled properly
      expect(result.failedResult.success).toBe(false);
      expect(result.failedResult.exitCode).not.toBe(0);
      expect(result.failedResult.stderr).toContain('not found');
      
      // Validate system remained healthy
      expect(result.healthAfterFailure).toBe('pong');
      
      // Validate recovery
      expect(result.successResult.success).toBe(true);
      expect(result.successResult.stdout.trim()).toBe('Recovery successful');
      
      // Validate file operations still work
      expect(result.fileContent).toBe('System recovered');
    }, 120000);

    it('should handle multiple consecutive failures without system degradation', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const failures = [];
        const commands = [
          'invalid-cmd-1',
          'false', // Command that always fails
          'exit 42',
          'bash -c "echo error >&2; exit 1"',
          'nonexistent-binary --invalid-flag'
        ];
        
        // Execute multiple failing commands
        for (const cmd of commands) {
          const result = await instance.client.commands.execute(cmd);
          failures.push({
            command: cmd,
            success: result.success,
            exitCode: result.exitCode
          });
        }
        
        // Verify system is still responsive
        const healthCheck = await instance.client.utils.ping();
        const successfulCmd = await instance.client.commands.execute('echo "Still working after $0 failures" | wc -w');
        
        return {
          failures,
          healthCheck,
          finalTest: successfulCmd
        };
      });

      // Validate all commands failed as expected
      expect(result.failures).toHaveLength(5);
      result.failures.forEach(failure => {
        expect(failure.success).toBe(false);
        expect(failure.exitCode).not.toBe(0);
      });
      
      // Validate system remained stable
      expect(result.healthCheck).toBe('pong');
      expect(result.finalTest.success).toBe(true);
    }, 120000);
  });

  describe('Process Crash Recovery', () => {
    it('should handle process crashes and cleanup properly', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create a process that will crash
        const crashingScript = `
#!/bin/bash
echo "Process starting..."
sleep 2
echo "About to crash..."
kill -9 $$  # Forcefully kill itself
        `.trim();

        await instance.client.files.writeFile('/tmp/crash.sh', crashingScript);
        await instance.client.commands.execute('chmod +x /tmp/crash.sh');
        
        // Start the crashing process
        const process = await instance.client.processes.startProcess('bash /tmp/crash.sh');
        
        // Wait for crash
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Check process status after crash
        const statusAfterCrash = await instance.client.processes.getProcess(process.id);
        
        // Verify system can still start new processes
        const newProcess = await instance.client.processes.startProcess('echo "New process after crash"');
        await new Promise(resolve => setTimeout(resolve, 1000));
        const newProcessStatus = await instance.client.processes.getProcess(newProcess.id);
        
        // List all processes to check cleanup
        const allProcesses = await instance.client.processes.listProcesses();
        
        // Verify system health
        const healthCheck = await instance.client.utils.ping();
        
        return {
          originalProcess: process,
          statusAfterCrash,
          newProcess,
          newProcessStatus,
          allProcesses,
          healthCheck
        };
      });

      // Validate original process crashed
      expect(result.originalProcess.status).toBe('running');
      expect(['completed', 'failed', 'killed'].includes(result.statusAfterCrash.status)).toBe(true);
      
      // Validate new process works
      expect(result.newProcess.status).toBe('running');
      expect(['running', 'completed'].includes(result.newProcessStatus.status)).toBe(true);
      
      // Validate system health
      expect(result.healthCheck).toBe('pong');
      
      // Validate process list functionality
      expect(result.allProcesses).toBeInstanceOf(Array);
      expect(result.allProcesses.length).toBeGreaterThanOrEqual(1);
    }, 120000);

    it('should handle resource exhaustion scenarios gracefully', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Start multiple processes to test resource limits
        const processes = [];
        const startTime = Date.now();
        
        try {
          // Try to start many background processes
          for (let i = 0; i < 10; i++) {
            const process = await instance.client.processes.startProcess(`sleep 5 && echo "Process ${i} completed"`);
            processes.push(process);
            
            // Small delay between starts
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (error) {
          // Expected to eventually hit limits
        }
        
        const timeToStart = Date.now() - startTime;
        
        // Check system state
        const allProcesses = await instance.client.processes.listProcesses();
        const healthCheck = await instance.client.utils.ping();
        
        // Try to start a new process to verify system recovery
        await new Promise(resolve => setTimeout(resolve, 6000)); // Wait for some to complete
        const recoveryProcess = await instance.client.processes.startProcess('echo "Recovery process works"');
        
        return {
          startedProcesses: processes.length,
          timeToStart,
          allProcesses: allProcesses.length,
          healthCheck,
          recoveryProcess
        };
      });

      // Validate some processes were started
      expect(result.startedProcesses).toBeGreaterThan(5);
      
      // Validate system remained responsive
      expect(result.healthCheck).toBe('pong');
      
      // Validate recovery after resource pressure
      expect(result.recoveryProcess.status).toBe('running');
    }, 120000);
  });

  describe('Port Conflict Resolution', () => {
    it('should handle port conflicts and provide clear error messages', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Start a simple server on port 7001
        const serverScript = `
#!/bin/bash
echo "Starting server on port 7001..."
python3 -c "
import http.server
import socketserver
PORT = 7001
Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Server running on port {PORT}')
    httpd.serve_forever()
" &
sleep 2
echo "Server should be running"
        `.trim();

        await instance.client.files.writeFile('/tmp/server.sh', serverScript);
        await instance.client.commands.execute('chmod +x /tmp/server.sh');
        
        // Start the server process
        const serverProcess = await instance.client.processes.startProcess('bash /tmp/server.sh');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Expose the port successfully
        const firstExpose = await instance.client.ports.exposePort({ port: 7001 });
        
        // Try to expose the same port again (should fail)
        let secondExposeError;
        try {
          await instance.client.ports.exposePort({ port: 7001 });
        } catch (error) {
          secondExposeError = error;
        }
        
        // Verify port is still exposed and functional
        const exposedPorts = await instance.client.ports.getExposedPorts();
        
        // Test that we can still expose different ports
        const differentPortExpose = await instance.client.ports.exposePort({ port: 7002 });
        
        return {
          serverProcess,
          firstExpose,
          secondExposeError,
          exposedPorts,
          differentPortExpose
        };
      });

      // Validate first exposure succeeded
      expect(result.firstExpose.port).toBe(7001);
      expect(result.firstExpose.url).toContain('7001');
      
      // Validate second exposure failed with proper error
      expect(result.secondExposeError).toBeInstanceOf(PortAlreadyExposedError);
      expect(result.secondExposeError.port).toBe(7001);
      expect(result.secondExposeError.code).toBe('PORT_ALREADY_EXPOSED');
      
      // Validate port list shows correct state
      expect(result.exposedPorts.some(p => p.port === 7001)).toBe(true);
      
      // Validate different port still works
      expect(result.differentPortExpose.port).toBe(7002);
    }, 120000);
  });

  describe('File System Error Recovery', () => {
    it('should handle file system errors and maintain consistency', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        const errors = [];
        
        // Try to read non-existent file
        try {
          await instance.client.files.readFile('/nonexistent/path/file.txt');
        } catch (error) {
          errors.push({ operation: 'read', error });
        }
        
        // Try to write to invalid path
        try {
          await instance.client.files.writeFile('/dev/null/invalid.txt', 'content');
        } catch (error) {
          errors.push({ operation: 'write', error });
        }
        
        // Try to delete non-existent file
        try {
          await instance.client.files.deleteFile('/does/not/exist.txt');
        } catch (error) {
          errors.push({ operation: 'delete', error });
        }
        
        // Verify system can still perform valid file operations
        await instance.client.files.writeFile('/tmp/recovery-file.txt', 'File system recovered');
        const content = await instance.client.files.readFile('/tmp/recovery-file.txt');
        
        // Test file listing still works
        const fileList = await instance.client.commands.execute('ls -la /tmp/');
        
        return {
          errors,
          recoveryContent: content,
          fileListSuccess: fileList.success
        };
      });

      // Validate expected errors occurred
      expect(result.errors).toHaveLength(3);
      
      // Validate read error
      const readError = result.errors.find(e => e.operation === 'read');
      expect(readError.error).toBeInstanceOf(FileNotFoundError);
      expect(readError.error.code).toBe('FILE_NOT_FOUND');
      
      // Validate system recovery
      expect(result.recoveryContent).toBe('File system recovered');
      expect(result.fileListSuccess).toBe(true);
    }, 120000);
  });

  describe('Network and Service Recovery', () => {
    it('should handle service unavailability and recover gracefully', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Start a service that will become unavailable
        const flakyServiceScript = `
#!/bin/bash
echo "Starting flaky service..."
python3 -c "
import http.server
import socketserver
import time
import threading
import sys

PORT = 8001

class FlakyHandler(http.server.BaseHTTPRequestHandler):
    request_count = 0
    
    def do_GET(self):
        FlakyHandler.request_count += 1
        
        if FlakyHandler.request_count <= 3:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = f'{{\\"status\\": \\"ok\\", \\"count\\": {FlakyHandler.request_count}}}'
            self.wfile.write(response.encode())
        else:
            # Simulate service becoming unavailable
            print('Service becoming unavailable')
            sys.exit(1)

with socketserver.TCPServer(('', PORT), FlakyHandler) as httpd:
    print(f'Flaky service on port {PORT}')
    httpd.serve_forever()
"
        `.trim();

        await instance.client.files.writeFile('/tmp/flaky.sh', flakyServiceScript);
        await instance.client.commands.execute('chmod +x /tmp/flaky.sh');
        
        // Start the flaky service
        const serviceProcess = await instance.client.processes.startProcess('bash /tmp/flaky.sh');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Make requests to the service
        const responses = [];
        for (let i = 1; i <= 5; i++) {
          const response = await instance.client.commands.execute(`curl -s http://localhost:8001/ || echo "Request ${i} failed"`);
          responses.push({
            attempt: i,
            success: response.success,
            output: response.stdout.trim()
          });
          
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Check if service process crashed
        await new Promise(resolve => setTimeout(resolve, 2000));
        const serviceStatus = await instance.client.processes.getProcess(serviceProcess.id);
        
        // Verify system can still start new services
        const newServiceScript = `
python3 -c "
import http.server
import socketserver
PORT = 8002
Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print('New service on 8002')
    httpd.serve_forever()
" &
sleep 1
echo 'New service started'
        `;
        
        const newService = await instance.client.processes.startProcess(newServiceScript);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const healthCheck = await instance.client.utils.ping();
        
        return {
          responses,
          serviceStatus,
          newService,
          healthCheck
        };
      });

      // Validate some requests succeeded before failure
      const successfulResponses = result.responses.filter(r => r.success && r.output.includes('status'));
      expect(successfulResponses.length).toBeGreaterThanOrEqual(2);
      
      // Validate some requests failed after service crash
      const failedResponses = result.responses.filter(r => r.output.includes('failed'));
      expect(failedResponses.length).toBeGreaterThan(0);
      
      // Validate service process crashed
      expect(['completed', 'failed', 'killed'].includes(result.serviceStatus.status)).toBe(true);
      
      // Validate system recovery
      expect(result.newService.status).toBe('running');
      expect(result.healthCheck).toBe('pong');
    }, 120000);
  });
});