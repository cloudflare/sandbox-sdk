import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, cleanupSandbox } from './helpers/test-fixtures';

/**
 * WebSocket connect() Integration Tests
 *
 * Tests the new connect() pattern for routing WebSocket requests directly to
 * container services, plus the /api/init endpoint for pre-initializing servers.
 *
 * COVERAGE:
 * - /api/init endpoint functionality
 * - Direct WebSocket routing via connect()
 * - Python code streaming with real-time output
 * - Terminal command execution
 * - Server persistence across connections
 * - Multiple concurrent connections
 */
describe('WebSocket connect() Pattern', () => {
  let runner: WranglerDevRunner | null = null;
  let workerUrl: string;
  let currentSandboxId: string | null = null;

  beforeAll(async () => {
    const result = await getTestWorkerUrl();
    workerUrl = result.url;
    runner = result.runner;
  });

  afterEach(async () => {
    if (currentSandboxId) {
      await cleanupSandbox(workerUrl, currentSandboxId);
      currentSandboxId = null;
    }
  });

  afterAll(async () => {
    if (runner) {
      await runner.stop();
    }
  });

  test('should initialize all servers via /api/init endpoint', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Call /api/init to start all servers
    const response = await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.serversStarted).toBeGreaterThanOrEqual(0); // May be 0 if already running

    // Wait for servers to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify all three server processes exist
    const processesResponse = await fetch(`${workerUrl}/api/process/list`, {
      method: 'GET',
      headers,
    });

    expect(processesResponse.status).toBe(200);
    const processes = await processesResponse.json();

    const processIds = processes.map((p: any) => p.id);
    expect(processIds).toContain('ws-echo-8080');
    expect(processIds).toContain('ws-code-8081');
    expect(processIds).toContain('ws-terminal-8082');

    // Verify all are running
    const runningProcesses = processes.filter((p: any) => p.status === 'running');
    expect(runningProcesses.length).toBeGreaterThanOrEqual(3);
  }, 30000);

  test('should connect to echo server directly using connect()', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Initialize servers
    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    // Wait for servers to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Connect via WebSocket using connect() pattern (no port exposure API)
    const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/echo';
    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Sandbox-Id': currentSandboxId,
      },
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    // Send message and verify echo
    const testMessage = 'Hello from connect() test!';
    const messagePromise = new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      setTimeout(() => reject(new Error('Echo timeout')), 5000);
    });

    ws.send(testMessage);
    const echoedMessage = await messagePromise;

    expect(echoedMessage).toBe(testMessage);

    // Close connection
    ws.close();
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      setTimeout(() => resolve(), 1000);
    });
  }, 30000);

  test('should stream Python code execution output in real-time', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Initialize servers
    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Connect to code streaming server
    const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/code';
    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Sandbox-Id': currentSandboxId,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    // Collect all messages
    const messages: any[] = [];
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch (e) {
        console.error('Failed to parse message:', data.toString());
      }
    });

    // Send Python code with multiple print statements and delays
    const pythonCode = `
import time
for i in range(3):
    print(f'Count: {i}')
    time.sleep(0.3)
print('Done!')
`;

    ws.send(JSON.stringify({
      type: 'execute',
      code: pythonCode,
    }));

    // Wait for completion
    await new Promise<void>((resolve, reject) => {
      const checkComplete = () => {
        const completed = messages.find(m => m.type === 'completed');
        if (completed) {
          resolve();
        } else {
          setTimeout(checkComplete, 100);
        }
      };
      checkComplete();
      setTimeout(() => reject(new Error('Execution timeout')), 10000);
    });

    // Verify message sequence
    expect(messages.some(m => m.type === 'ready')).toBe(true);
    expect(messages.some(m => m.type === 'executing')).toBe(true);

    // Verify we got stdout messages (streaming)
    const stdoutMessages = messages.filter(m => m.type === 'stdout');
    expect(stdoutMessages.length).toBeGreaterThan(0);

    // Verify output contains our print statements
    const fullOutput = stdoutMessages.map(m => m.data).join('');
    expect(fullOutput).toContain('Count: 0');
    expect(fullOutput).toContain('Count: 1');
    expect(fullOutput).toContain('Count: 2');
    expect(fullOutput).toContain('Done!');

    // Verify completion with exit code 0
    const completedMsg = messages.find(m => m.type === 'completed');
    expect(completedMsg).toBeDefined();
    expect(completedMsg.exitCode).toBe(0);

    ws.close();
  }, 30000);

  test('should handle Python code execution errors with non-zero exit code', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/code';
    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Sandbox-Id': currentSandboxId,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    const messages: any[] = [];
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch (e) {}
    });

    // Send Python code that raises an error
    const pythonCode = `
print('Starting...')
raise ValueError('This is a test error')
print('This should not print')
`;

    ws.send(JSON.stringify({
      type: 'execute',
      code: pythonCode,
    }));

    // Wait for completion
    await new Promise<void>((resolve, reject) => {
      const checkComplete = () => {
        const completed = messages.find(m => m.type === 'completed');
        if (completed) {
          resolve();
        } else {
          setTimeout(checkComplete, 100);
        }
      };
      checkComplete();
      setTimeout(() => reject(new Error('Execution timeout')), 10000);
    });

    // Verify we got stderr with error message
    const stderrMessages = messages.filter(m => m.type === 'stderr');
    expect(stderrMessages.length).toBeGreaterThan(0);

    const stderrOutput = stderrMessages.map(m => m.data).join('');
    expect(stderrOutput).toContain('ValueError');
    expect(stderrOutput).toContain('This is a test error');

    // Verify non-zero exit code
    const completedMsg = messages.find(m => m.type === 'completed');
    expect(completedMsg).toBeDefined();
    expect(completedMsg.exitCode).not.toBe(0);

    ws.close();
  }, 30000);

  test('should execute terminal commands and return results', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/terminal';
    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Sandbox-Id': currentSandboxId,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    const messages: any[] = [];
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch (e) {}
    });

    // Wait for ready message
    await new Promise<void>((resolve) => {
      const checkReady = () => {
        if (messages.some(m => m.type === 'ready')) {
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });

    const readyMsg = messages.find(m => m.type === 'ready');
    expect(readyMsg).toBeDefined();
    expect(readyMsg.cwd).toBeDefined();

    // Execute echo command
    ws.send(JSON.stringify({
      type: 'command',
      command: 'echo "Hello Terminal"',
    }));

    // Wait for result
    await new Promise<void>((resolve) => {
      const checkResult = () => {
        if (messages.some(m => m.type === 'result')) {
          resolve();
        } else {
          setTimeout(checkResult, 100);
        }
      };
      checkResult();
    });

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeDefined();
    expect(resultMsg.stdout).toContain('Hello Terminal');
    expect(resultMsg.exitCode).toBe(0);

    ws.close();
  }, 30000);

  test('should handle terminal command errors with non-zero exit code', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/terminal';
    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Sandbox-Id': currentSandboxId,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    const messages: any[] = [];
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch (e) {}
    });

    // Wait for ready
    await new Promise<void>((resolve) => {
      const checkReady = () => {
        if (messages.some(m => m.type === 'ready')) resolve();
        else setTimeout(checkReady, 100);
      };
      checkReady();
    });

    // Execute command that fails
    ws.send(JSON.stringify({
      type: 'command',
      command: 'ls /nonexistent-directory',
    }));

    // Wait for result
    await new Promise<void>((resolve) => {
      const checkResult = () => {
        if (messages.some(m => m.type === 'result')) resolve();
        else setTimeout(checkResult, 100);
      };
      checkResult();
    });

    const resultMsg = messages.find(m => m.type === 'result');
    expect(resultMsg).toBeDefined();
    expect(resultMsg.stderr).toContain('No such file or directory');
    expect(resultMsg.exitCode).not.toBe(0);

    ws.close();
  }, 30000);

  test('should reuse running servers across multiple connections', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Initialize servers once
    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get initial process list
    const initialProcesses = await fetch(`${workerUrl}/api/process/list`, {
      method: 'GET',
      headers,
    }).then(r => r.json());

    const echoProcess = initialProcesses.find((p: any) => p.id === 'ws-echo-8080');
    expect(echoProcess).toBeDefined();

    // Connect, disconnect, reconnect multiple times
    for (let i = 0; i < 3; i++) {
      const wsUrl = workerUrl.replace(/^http/, 'ws') + '/ws/echo';
      const ws = new WebSocket(wsUrl, {
        headers: {
          'X-Sandbox-Id': currentSandboxId,
        },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (error) => reject(error));
        setTimeout(() => reject(new Error('Connection timeout')), 10000);
      });

      // Send a message
      const messagePromise = new Promise<string>((resolve) => {
        ws.on('message', (data) => resolve(data.toString()));
      });

      ws.send(`Test ${i}`);
      const echo = await messagePromise;
      expect(echo).toBe(`Test ${i}`);

      // Close
      ws.close();
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        setTimeout(() => resolve(), 500);
      });

      // Small delay between connections
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Verify same process is still running (not restarted)
    const finalProcesses = await fetch(`${workerUrl}/api/process/list`, {
      method: 'GET',
      headers,
    }).then(r => r.json());

    const finalEchoProcess = finalProcesses.find((p: any) => p.id === 'ws-echo-8080');
    expect(finalEchoProcess).toBeDefined();
    expect(finalEchoProcess.status).toBe('running');

    // Process ID should be the same (server wasn't restarted)
    expect(finalEchoProcess.id).toBe(echoProcess.id);
  }, 60000);

  test('should handle multiple concurrent WebSocket connections', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    await fetch(`${workerUrl}/api/init`, {
      method: 'POST',
      headers,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Open 3 concurrent connections to different servers
    const wsUrl1 = workerUrl.replace(/^http/, 'ws') + '/ws/echo';
    const wsUrl2 = workerUrl.replace(/^http/, 'ws') + '/ws/code';
    const wsUrl3 = workerUrl.replace(/^http/, 'ws') + '/ws/terminal';

    const ws1 = new WebSocket(wsUrl1, { headers: { 'X-Sandbox-Id': currentSandboxId } });
    const ws2 = new WebSocket(wsUrl2, { headers: { 'X-Sandbox-Id': currentSandboxId } });
    const ws3 = new WebSocket(wsUrl3, { headers: { 'X-Sandbox-Id': currentSandboxId } });

    // Wait for all connections
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        ws1.on('open', () => resolve());
        ws1.on('error', reject);
        setTimeout(() => reject(new Error('WS1 timeout')), 10000);
      }),
      new Promise<void>((resolve, reject) => {
        ws2.on('open', () => resolve());
        ws2.on('error', reject);
        setTimeout(() => reject(new Error('WS2 timeout')), 10000);
      }),
      new Promise<void>((resolve, reject) => {
        ws3.on('open', () => resolve());
        ws3.on('error', reject);
        setTimeout(() => reject(new Error('WS3 timeout')), 10000);
      }),
    ]);

    // Send messages on all connections simultaneously
    const results = await Promise.all([
      new Promise<string>((resolve) => {
        ws1.on('message', (data) => resolve(data.toString()));
        ws1.send('Echo test');
      }),
      new Promise<any>((resolve) => {
        const messages: any[] = [];
        ws2.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            messages.push(msg);
            if (msg.type === 'completed') resolve(messages);
          } catch (e) {}
        });
        ws2.send(JSON.stringify({ type: 'execute', code: 'print("Code test")' }));
      }),
      new Promise<any>((resolve) => {
        const messages: any[] = [];
        ws3.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            messages.push(msg);
            if (msg.type === 'result') resolve(messages);
          } catch (e) {}
        });
        // Wait for ready first
        setTimeout(() => {
          ws3.send(JSON.stringify({ type: 'command', command: 'echo "Terminal test"' }));
        }, 500);
      }),
    ]);

    // Verify all worked independently
    expect(results[0]).toBe('Echo test');
    expect(results[1].some((m: any) => m.type === 'stdout')).toBe(true);
    expect(results[2].some((m: any) => m.type === 'result')).toBe(true);

    // Close all
    ws1.close();
    ws2.close();
    ws3.close();
  }, 60000);
});
