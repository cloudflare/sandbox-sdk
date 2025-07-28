import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { SandboxClient } from '../../clients/sandbox-client';
import { Sandbox } from '../../sandbox';
import type { DurableObjectStub } from '@cloudflare/workers-types';

/**
 * Integration tests for SandboxClient → Container communication
 * Tests the full request flow through the modular client architecture
 */
describe('Client-Container Integration', () => {
  let sandbox: DurableObjectStub;
  let client: SandboxClient;

  beforeEach(async () => {
    // Get a Durable Object stub for the Sandbox
    sandbox = await runInDurableObject(Sandbox, async (instance, state) => {
      // Initialize the sandbox instance
      await instance.getSandbox();
      return instance;
    });

    // Create client with stub pointing to the Durable Object
    client = new SandboxClient({
      baseUrl: 'http://localhost',
      port: 3000,
      stub: {
        containerFetch: async (url: string, options: RequestInit) => {
          // Route requests through the Durable Object
          const request = new Request(url, options);
          return await sandbox.fetch(request);
        }
      }
    });
  });

  afterEach(async () => {
    // Clean up any running processes
    try {
      await client.processes.killAllProcesses();
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('SandboxClient Orchestration', () => {
    it('should successfully ping through all client layers', async () => {
      const result = await client.ping();
      
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should get comprehensive sandbox info through multiple clients', async () => {
      const info = await client.getInfo();
      
      expect(info).toHaveProperty('ping');
      expect(info).toHaveProperty('commands');
      expect(info).toHaveProperty('exposedPorts');
      expect(info).toHaveProperty('runningProcesses');
      
      expect(typeof info.ping).toBe('string');
      expect(Array.isArray(info.commands)).toBe(true);
      expect(typeof info.exposedPorts).toBe('number');
      expect(typeof info.runningProcesses).toBe('number');
      expect(info.exposedPorts).toBeGreaterThanOrEqual(0);
      expect(info.runningProcesses).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Cross-Client Operation Coordination', () => {
    it('should coordinate file creation → command execution → process management', async () => {
      const sessionId = 'test-coordination-session';
      client.setSessionId(sessionId);

      // 1. Create a test script file
      const scriptContent = '#!/bin/bash\necho "Hello from coordinated test"\nsleep 2\necho "Script completed"';
      await client.files.writeFile('/tmp/test-script.sh', scriptContent);

      // 2. Make it executable and run it as a background process
      await client.commands.execute('chmod +x /tmp/test-script.sh', { sessionId });
      
      const processResult = await client.processes.startProcess({
        command: '/tmp/test-script.sh',
        background: true,
        sessionId
      });
      
      expect(processResult.success).toBe(true);
      expect(processResult.processId).toBeDefined();

      // 3. Verify the process is running
      const processList = await client.processes.listProcesses();
      const ourProcess = processList.processes.find(p => p.id === processResult.processId);
      
      expect(ourProcess).toBeDefined();
      expect(ourProcess?.status).toBe('running');

      // 4. Wait for process completion and verify file operations worked
      let completed = false;
      let attempts = 0;
      const maxAttempts = 10;

      while (!completed && attempts < maxAttempts) {
        const updatedList = await client.processes.listProcesses();
        const process = updatedList.processes.find(p => p.id === processResult.processId);
        
        if (process?.status === 'completed') {
          completed = true;
          
          // Get process logs to verify our script ran
          const logs = await client.processes.getProcessLogs(processResult.processId!);
          expect(logs.logs).toContain('Hello from coordinated test');
          expect(logs.logs).toContain('Script completed');
        } else {
          await new Promise(resolve => setTimeout(resolve, 500));
          attempts++;
        }
      }

      expect(completed).toBe(true);

      // 5. Clean up the test file
      await client.files.deleteFile('/tmp/test-script.sh');
    });

    it('should coordinate git clone → file operations → command execution', async () => {
      const sessionId = 'test-git-coordination';
      client.setSessionId(sessionId);

      // 1. Clone a simple repository (use a well-known public repo)
      await client.git.checkout({
        repository: 'https://github.com/octocat/Hello-World.git',
        directory: '/tmp/hello-world',
        sessionId
      });

      // 2. Verify repository was cloned by checking for files
      const readmeResult = await client.commands.execute('ls -la /tmp/hello-world', { sessionId });
      expect(readmeResult.success).toBe(true);
      expect(readmeResult.stdout).toContain('README');

      // 3. Read a file from the cloned repository
      try {
        const readmeContent = await client.files.readFile('/tmp/hello-world/README');
        expect(typeof readmeContent).toBe('string');
        expect(readmeContent.length).toBeGreaterThan(0);
      } catch (error) {
        // Some repos might not have README, try different common files
        const lsResult = await client.commands.execute('find /tmp/hello-world -type f | head -5', { sessionId });
        expect(lsResult.success).toBe(true);
        expect(lsResult.stdout.trim().length).toBeGreaterThan(0);
      }

      // 4. Clean up
      await client.commands.execute('rm -rf /tmp/hello-world', { sessionId });
    });
  });

  describe('Session State Management', () => {
    it('should maintain session state across multiple client operations', async () => {
      const sessionId = 'persistent-session-test';
      client.setSessionId(sessionId);

      // 1. Set an environment variable through commands client
      await client.commands.execute('export TEST_SESSION_VAR="session-value"', { sessionId });

      // 2. Create a file through files client  
      await client.files.writeFile('/tmp/session-test.txt', 'session data');

      // 3. Change directory through commands client
      await client.commands.execute('cd /tmp', { sessionId });

      // 4. Verify session persistence - environment variable should still exist
      const envResult = await client.commands.execute('echo $TEST_SESSION_VAR', { sessionId });
      expect(envResult.stdout.trim()).toBe('session-value');

      // 5. Verify we're still in the /tmp directory
      const pwdResult = await client.commands.execute('pwd', { sessionId });
      expect(pwdResult.stdout.trim()).toBe('/tmp');

      // 6. Verify file exists in current directory
      const lsResult = await client.commands.execute('ls session-test.txt', { sessionId });
      expect(lsResult.success).toBe(true);
      expect(lsResult.stdout.trim()).toBe('session-test.txt');

      // Clean up
      await client.files.deleteFile('/tmp/session-test.txt');
    });

    it('should isolate sessions between different session IDs', async () => {
      // Session 1
      const session1 = 'isolated-session-1';
      client.setSessionId(session1);
      await client.commands.execute('export SESSION_1_VAR="value1"', { sessionId: session1 });
      await client.commands.execute('cd /tmp', { sessionId: session1 });

      // Session 2
      const session2 = 'isolated-session-2';
      client.setSessionId(session2);
      await client.commands.execute('export SESSION_2_VAR="value2"', { sessionId: session2 });
      await client.commands.execute('cd /usr', { sessionId: session2 });

      // Verify session 1 isolation
      client.setSessionId(session1);
      const session1EnvResult = await client.commands.execute('echo $SESSION_1_VAR', { sessionId: session1 });
      expect(session1EnvResult.stdout.trim()).toBe('value1');
      
      const session1PwdResult = await client.commands.execute('pwd', { sessionId: session1 });
      expect(session1PwdResult.stdout.trim()).toBe('/tmp');

      // Verify session 2 isolation
      client.setSessionId(session2);
      const session2EnvResult = await client.commands.execute('echo $SESSION_2_VAR', { sessionId: session2 });
      expect(session2EnvResult.stdout.trim()).toBe('value2');
      
      const session2PwdResult = await client.commands.execute('pwd', { sessionId: session2 });
      expect(session2PwdResult.stdout.trim()).toBe('/usr');

      // Verify cross-session variable isolation
      const crossCheckResult = await client.commands.execute('echo $SESSION_1_VAR', { sessionId: session2 });
      expect(crossCheckResult.stdout.trim()).toBe(''); // Should be empty
    });
  });

  describe('Port Management Integration', () => {
    it('should coordinate service startup → port exposure → health checking', async () => {
      const sessionId = 'port-integration-test';
      client.setSessionId(sessionId);

      // 1. Start a simple HTTP server in the background
      const serverScript = `
        python3 -c "
import http.server
import socketserver
import threading
import time

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'Hello from test server')

PORT = 8080
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Server running on port {PORT}')
    httpd.serve_forever()
" &
      `;

      // 2. Start the server process
      const processResult = await client.processes.startProcess({
        command: serverScript,
        background: true,
        sessionId
      });

      expect(processResult.success).toBe(true);
      expect(processResult.processId).toBeDefined();

      // 3. Wait a moment for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 4. Expose the port
      const exposeResult = await client.ports.exposePort({
        port: 8080,
        name: 'test-server'
      });

      expect(exposeResult.success).toBe(true);
      expect(exposeResult.url).toBeDefined();
      expect(exposeResult.url).toContain('8080');

      // 5. Verify port is listed as exposed
      const exposedPorts = await client.ports.getExposedPorts();
      const ourPort = exposedPorts.ports.find(p => p.port === 8080);
      
      expect(ourPort).toBeDefined();
      expect(ourPort?.name).toBe('test-server');
      expect(ourPort?.isActive).toBe(true);

      // 6. Clean up - unexpose port and kill process
      await client.ports.unexposePort(8080);
      if (processResult.processId) {
        await client.processes.killProcess(processResult.processId);
      }

      // 7. Verify cleanup
      const finalPortsList = await client.ports.getExposedPorts();
      const portStillExposed = finalPortsList.ports.find(p => p.port === 8080);
      expect(portStillExposed).toBeUndefined();
    });
  });
});