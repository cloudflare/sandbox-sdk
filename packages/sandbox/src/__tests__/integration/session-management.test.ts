import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { SandboxClient } from '../../clients/sandbox-client';
import { Sandbox } from '../../sandbox';
import type { DurableObjectStub } from '@cloudflare/workers-types';

/**
 * Integration tests for session management across modular clients
 * Validates session sharing, isolation, and persistence in the Workers environment
 */
describe('Session Management Integration', () => {
  let sandbox: DurableObjectStub;
  let client: SandboxClient;

  beforeEach(async () => {
    // Get a Durable Object stub for the Sandbox
    sandbox = await runInDurableObject(Sandbox, async (instance, state) => {
      await instance.getSandbox();
      return instance;
    });

    // Create client with stub pointing to the Durable Object
    client = new SandboxClient({
      baseUrl: 'http://localhost',
      port: 3000,
      stub: {
        containerFetch: async (url: string, options: RequestInit) => {
          const request = new Request(url, options);
          return await sandbox.fetch(request);
        }
      }
    });
  });

  afterEach(async () => {
    // Clean up any test files and processes
    try {
      await client.processes.killAllProcesses();
      await client.files.deleteFile('/tmp/session-test-1.txt').catch(() => {});
      await client.files.deleteFile('/tmp/session-test-2.txt').catch(() => {});
      await client.files.deleteFile('/tmp/shared-session-file.txt').catch(() => {});
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Session Sharing Across Domain Clients', () => {
    it('should share session state between CommandClient and FileClient', async () => {
      const sessionId = 'shared-command-file-session';
      client.setSessionId(sessionId);

      // 1. Set working directory via CommandClient
      await client.commands.execute('cd /tmp', { sessionId });

      // 2. Set environment variable via CommandClient
      await client.commands.execute('export SHARED_VAR="test-value"', { sessionId });

      // 3. Create file via FileClient (should be created in /tmp due to session state)
      await client.files.writeFile('session-test-file.txt', 'test content');

      // 4. Verify file exists in expected location via CommandClient
      const lsResult = await client.commands.execute('ls session-test-file.txt', { sessionId });
      expect(lsResult.success).toBe(true);
      expect(lsResult.stdout.trim()).toBe('session-test-file.txt');

      // 5. Verify environment variable persists via CommandClient
      const envResult = await client.commands.execute('echo $SHARED_VAR', { sessionId });
      expect(envResult.stdout.trim()).toBe('test-value');

      // 6. Verify working directory persists
      const pwdResult = await client.commands.execute('pwd', { sessionId });
      expect(pwdResult.stdout.trim()).toBe('/tmp');

      // Clean up
      await client.files.deleteFile('/tmp/session-test-file.txt');
    });

    it('should share session state between ProcessClient and CommandClient', async () => {
      const sessionId = 'shared-process-command-session';
      client.setSessionId(sessionId);

      // 1. Set environment variable and working directory via CommandClient
      await client.commands.execute('cd /tmp && export PROCESS_VAR="process-value"', { sessionId });

      // 2. Create a script that uses the session environment
      const scriptContent = '#!/bin/bash\necho "Environment: $PROCESS_VAR"\necho "Working directory: $(pwd)"';
      await client.files.writeFile('/tmp/session-process-test.sh', scriptContent);
      await client.commands.execute('chmod +x /tmp/session-process-test.sh', { sessionId });

      // 3. Start process via ProcessClient (should inherit session state)
      const processResult = await client.processes.startProcess({
        command: '/tmp/session-process-test.sh',
        background: false,
        sessionId
      });

      expect(processResult.success).toBe(true);
      expect(processResult.processId).toBeDefined();

      // 4. Wait for process completion and check logs
      let completed = false;
      let attempts = 0;
      const maxAttempts = 10;

      while (!completed && attempts < maxAttempts) {
        const processList = await client.processes.listProcesses();
        const process = processList.processes.find(p => p.id === processResult.processId);
        
        if (process?.status === 'completed') {
          completed = true;
          
          const logs = await client.processes.getProcessLogs(processResult.processId!);
          expect(logs.logs).toContain('Environment: process-value');
          expect(logs.logs).toContain('Working directory: /tmp');
        } else {
          await new Promise(resolve => setTimeout(resolve, 500));
          attempts++;
        }
      }

      expect(completed).toBe(true);

      // Clean up
      await client.files.deleteFile('/tmp/session-process-test.sh');
    });

    it('should maintain session state across all domain clients', async () => {
      const sessionId = 'all-clients-session';
      client.setSessionId(sessionId);

      // 1. Initialize session state via CommandClient
      await client.commands.execute('cd /tmp && export GLOBAL_VAR="global-value"', { sessionId });

      // 2. Create file via FileClient
      await client.files.writeFile('global-session-file.txt', 'global content');

      // 3. Start a background process via ProcessClient that monitors the file
      const monitorScript = `
#!/bin/bash
echo "Monitor started in: $(pwd)"
echo "Global var: $GLOBAL_VAR"
while [ -f global-session-file.txt ]; do
  echo "File exists, size: $(wc -c < global-session-file.txt)"
  sleep 1
done
echo "File removed, monitor exiting"
      `;
      
      await client.files.writeFile('/tmp/monitor.sh', monitorScript);
      await client.commands.execute('chmod +x /tmp/monitor.sh', { sessionId });

      const processResult = await client.processes.startProcess({
        command: '/tmp/monitor.sh',
        background: true,
        sessionId
      });

      expect(processResult.success).toBe(true);

      // 4. Give process time to start monitoring
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 5. Modify file via FileClient (should be detected by process)
      await client.files.writeFile('/tmp/global-session-file.txt', 'modified global content');

      // 6. Wait a bit for process to detect changes
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 7. Remove file via FileClient to stop monitoring
      await client.files.deleteFile('/tmp/global-session-file.txt');

      // 8. Wait for process to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 9. Check process logs to verify session state was maintained
      const logs = await client.processes.getProcessLogs(processResult.processId!);
      expect(logs.logs).toContain('Monitor started in: /tmp');
      expect(logs.logs).toContain('Global var: global-value');
      expect(logs.logs).toContain('File exists');

      // Clean up
      await client.files.deleteFile('/tmp/monitor.sh').catch(() => {});
      if (processResult.processId) {
        await client.processes.killProcess(processResult.processId).catch(() => {});
      }
    });
  });

  describe('Session Isolation Between Different Sessions', () => {
    it('should isolate environment variables between sessions', async () => {
      // Session 1
      const session1 = 'isolation-session-1';
      client.setSessionId(session1);
      await client.commands.execute('export SESSION_1_ONLY="value1"', { sessionId: session1 });

      // Session 2
      const session2 = 'isolation-session-2';
      client.setSessionId(session2);
      await client.commands.execute('export SESSION_2_ONLY="value2"', { sessionId: session2 });

      // Verify session 1 variables don't leak to session 2
      const session2CheckResult = await client.commands.execute('echo $SESSION_1_ONLY', { sessionId: session2 });
      expect(session2CheckResult.stdout.trim()).toBe('');

      // Verify session 2 variables don't leak to session 1
      client.setSessionId(session1);
      const session1CheckResult = await client.commands.execute('echo $SESSION_2_ONLY', { sessionId: session1 });
      expect(session1CheckResult.stdout.trim()).toBe('');

      // Verify each session still has its own variables
      const session1VarResult = await client.commands.execute('echo $SESSION_1_ONLY', { sessionId: session1 });
      expect(session1VarResult.stdout.trim()).toBe('value1');

      client.setSessionId(session2);
      const session2VarResult = await client.commands.execute('echo $SESSION_2_ONLY', { sessionId: session2 });
      expect(session2VarResult.stdout.trim()).toBe('value2');
    });

    it('should isolate working directories between sessions', async () => {
      // Session 1 - work in /tmp
      const session1 = 'dir-isolation-session-1';
      client.setSessionId(session1);
      await client.commands.execute('cd /tmp', { sessionId: session1 });

      // Session 2 - work in /usr
      const session2 = 'dir-isolation-session-2';
      client.setSessionId(session2);
      await client.commands.execute('cd /usr', { sessionId: session2 });

      // Verify session 1 is still in /tmp
      client.setSessionId(session1);
      const session1PwdResult = await client.commands.execute('pwd', { sessionId: session1 });
      expect(session1PwdResult.stdout.trim()).toBe('/tmp');

      // Verify session 2 is still in /usr
      client.setSessionId(session2);
      const session2PwdResult = await client.commands.execute('pwd', { sessionId: session2 });
      expect(session2PwdResult.stdout.trim()).toBe('/usr');
    });

    it('should isolate file operations between sessions when using relative paths', async () => {
      // Session 1 - create file in /tmp
      const session1 = 'file-isolation-session-1';
      client.setSessionId(session1);
      await client.commands.execute('cd /tmp', { sessionId: session1 });
      await client.files.writeFile('session1-file.txt', 'session 1 content');

      // Session 2 - create file in /usr
      const session2 = 'file-isolation-session-2';
      client.setSessionId(session2);
      await client.commands.execute('cd /usr', { sessionId: session2 });
      await client.files.writeFile('session2-file.txt', 'session 2 content');

      // Verify session 1 can see its file
      client.setSessionId(session1);
      const session1LsResult = await client.commands.execute('ls session1-file.txt', { sessionId: session1 });
      expect(session1LsResult.success).toBe(true);

      // Verify session 1 cannot see session 2's file
      const session1CheckSession2Result = await client.commands.execute('ls session2-file.txt', { sessionId: session1 });
      expect(session1CheckSession2Result.success).toBe(false);

      // Verify session 2 can see its file
      client.setSessionId(session2);
      const session2LsResult = await client.commands.execute('ls session2-file.txt', { sessionId: session2 });
      expect(session2LsResult.success).toBe(true);

      // Verify session 2 cannot see session 1's file
      const session2CheckSession1Result = await client.commands.execute('ls session1-file.txt', { sessionId: session2 });
      expect(session2CheckSession1Result.success).toBe(false);

      // Clean up
      await client.files.deleteFile('/tmp/session1-file.txt').catch(() => {});
      await client.files.deleteFile('/usr/session2-file.txt').catch(() => {});
    });
  });

  describe('Session Persistence in Long-Running Operations', () => {
    it('should maintain session state during long-running processes', async () => {
      const sessionId = 'long-running-session';
      client.setSessionId(sessionId);

      // 1. Set up session state
      await client.commands.execute('cd /tmp && export LONG_VAR="persistent-value"', { sessionId });

      // 2. Start a long-running process that periodically checks session state
      const longScript = `
#!/bin/bash
echo "Long process started in: $(pwd)"
echo "Initial var: $LONG_VAR"

for i in {1..5}; do
  echo "Iteration $i - Var: $LONG_VAR - Dir: $(pwd)"
  echo "Checking session state at $(date)"
  sleep 1
done

echo "Long process completed"
      `;

      await client.files.writeFile('/tmp/long-process.sh', longScript);
      await client.commands.execute('chmod +x /tmp/long-process.sh', { sessionId });

      const processResult = await client.processes.startProcess({
        command: '/tmp/long-process.sh',
        background: true,
        sessionId
      });

      expect(processResult.success).toBe(true);

      // 3. While process is running, perform other operations in the same session
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Create a file to verify session is still active
      await client.files.writeFile('session-active-marker.txt', 'session is active');
      
      const markerCheckResult = await client.commands.execute('ls session-active-marker.txt', { sessionId });
      expect(markerCheckResult.success).toBe(true);

      // 4. Wait for long process to complete
      let completed = false;
      let attempts = 0;
      const maxAttempts = 15;

      while (!completed && attempts < maxAttempts) {
        const processList = await client.processes.listProcesses();
        const process = processList.processes.find(p => p.id === processResult.processId);
        
        if (process?.status === 'completed') {
          completed = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, 500));
          attempts++;
        }
      }

      expect(completed).toBe(true);

      // 5. Verify session state was maintained throughout
      const logs = await client.processes.getProcessLogs(processResult.processId!);
      expect(logs.logs).toContain('Long process started in: /tmp');
      expect(logs.logs).toContain('Initial var: persistent-value');
      expect(logs.logs).toMatch(/Iteration \d+ - Var: persistent-value - Dir: \/tmp/);

      // Clean up
      await client.files.deleteFile('/tmp/long-process.sh').catch(() => {});
      await client.files.deleteFile('/tmp/session-active-marker.txt').catch(() => {});
    });

    it('should handle session state during concurrent operations', async () => {
      const sessionId = 'concurrent-session';
      client.setSessionId(sessionId);

      // Set up session state
      await client.commands.execute('cd /tmp && export CONCURRENT_VAR="concurrent-value"', { sessionId });

      // Start multiple concurrent operations that all use the session
      const operations = [
        // File operations
        client.files.writeFile('concurrent-file-1.txt', 'concurrent content 1'),
        client.files.writeFile('concurrent-file-2.txt', 'concurrent content 2'),
        
        // Command operations
        client.commands.execute('echo $CONCURRENT_VAR > concurrent-output-1.txt', { sessionId }),
        client.commands.execute('echo $CONCURRENT_VAR > concurrent-output-2.txt', { sessionId }),
        
        // Process operations (short-running)
        client.processes.startProcess({
          command: 'echo "Process 1: $CONCURRENT_VAR" > concurrent-process-1.txt',
          background: false,
          sessionId
        }),
        client.processes.startProcess({
          command: 'echo "Process 2: $CONCURRENT_VAR" > concurrent-process-2.txt',
          background: false,
          sessionId
        })
      ];

      // Wait for all operations to complete
      const results = await Promise.all(operations);

      // Verify all operations succeeded
      results.forEach((result, index) => {
        if (result && typeof result === 'object' && 'success' in result) {
          expect(result.success).toBe(true);
        }
      });

      // Verify session state was maintained for all operations
      const verifyResults = await Promise.all([
        client.commands.execute('cat concurrent-output-1.txt', { sessionId }),
        client.commands.execute('cat concurrent-output-2.txt', { sessionId }),
        client.commands.execute('cat concurrent-process-1.txt', { sessionId }),
        client.commands.execute('cat concurrent-process-2.txt', { sessionId })
      ]);

      verifyResults.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.stdout.trim()).toContain('concurrent-value');
      });

      // Clean up
      const cleanupFiles = [
        'concurrent-file-1.txt', 'concurrent-file-2.txt',
        'concurrent-output-1.txt', 'concurrent-output-2.txt',
        'concurrent-process-1.txt', 'concurrent-process-2.txt'
      ];

      await Promise.all(
        cleanupFiles.map(file => 
          client.files.deleteFile(`/tmp/${file}`).catch(() => {})
        )
      );
    });
  });

  describe('Session ID Management', () => {
    it('should properly set and get session IDs across all clients', async () => {
      const testSessionId = 'test-session-management-123';
      
      // Initially should be null
      expect(client.getSessionId()).toBeNull();

      // Set session ID
      client.setSessionId(testSessionId);
      expect(client.getSessionId()).toBe(testSessionId);

      // Verify session ID is used in operations
      await client.commands.execute('export SESSION_ID_VAR="test-value"', { sessionId: testSessionId });
      
      const result = await client.commands.execute('echo $SESSION_ID_VAR', { sessionId: testSessionId });
      expect(result.stdout.trim()).toBe('test-value');

      // Clear session ID
      client.setSessionId(null);
      expect(client.getSessionId()).toBeNull();
    });

    it('should handle operations with explicit session ID overrides', async () => {
      const defaultSessionId = 'default-session';
      const overrideSessionId = 'override-session';

      // Set default session
      client.setSessionId(defaultSessionId);

      // Set variable in default session
      await client.commands.execute('export DEFAULT_VAR="default-value"', { sessionId: defaultSessionId });

      // Set variable in override session
      await client.commands.execute('export OVERRIDE_VAR="override-value"', { sessionId: overrideSessionId });

      // Verify override session doesn't see default session variable
      const overrideCheckResult = await client.commands.execute('echo $DEFAULT_VAR', { sessionId: overrideSessionId });
      expect(overrideCheckResult.stdout.trim()).toBe('');

      // Verify default session doesn't see override session variable
      const defaultCheckResult = await client.commands.execute('echo $OVERRIDE_VAR', { sessionId: defaultSessionId });
      expect(defaultCheckResult.stdout.trim()).toBe('');

      // Verify each session can see its own variables
      const defaultVarResult = await client.commands.execute('echo $DEFAULT_VAR', { sessionId: defaultSessionId });
      expect(defaultVarResult.stdout.trim()).toBe('default-value');

      const overrideVarResult = await client.commands.execute('echo $OVERRIDE_VAR', { sessionId: overrideSessionId });
      expect(overrideVarResult.stdout.trim()).toBe('override-value');
    });
  });
});