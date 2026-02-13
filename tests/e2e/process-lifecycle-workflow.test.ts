import type { ExecResult, Process, ProcessLogsResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

// Dedicated port for this test file's port exposure error tests
const PORT_LIFECYCLE_TEST_PORT = 9998;
const skipPortExposureTests =
  process.env.TEST_WORKER_URL?.endsWith('.workers.dev') ?? false;

/**
 * Process Lifecycle Error Handling Tests
 *
 * Tests error cases for process management.
 * Happy path tests (start, list, logs, kill, kill-all) are in comprehensive-workflow.test.ts.
 *
 * This file focuses on:
 * - Killing nonexistent process
 * - Exposing reserved ports
 * - Unexposing non-exposed ports
 * - Foreground operations not blocking on background processes
 */
describe('Process Lifecycle Error Handling', () => {
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
    // Port exposure requires sandbox headers (not session headers)
    portHeaders = {
      'X-Sandbox-Id': sandbox.sandboxId,
      'Content-Type': 'application/json'
    };
  }, 120000);

  async function readExecStdout(command: string): Promise<string> {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command
      })
    });

    expect(response.status).toBe(200);

    const result = (await response.json()) as ExecResult;
    return result.stdout.trim();
  }

  async function waitForChildPid(
    pidFilePath: string,
    timeoutMs = 10000
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const output = await readExecStdout(`cat '${pidFilePath}'`);
      const pid = Number.parseInt(output, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for child pid file: ${pidFilePath}`);
  }

  async function waitForProcessExit(
    processId: string,
    timeoutMs = 5000
  ): Promise<void> {
    const response = await fetch(
      `${workerUrl}/api/process/${processId}/waitForExit`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ timeout: timeoutMs })
      }
    );

    expect(response.status).toBe(200);
  }

  async function isProcessAlive(
    pid: number,
    expectedCommand?: string
  ): Promise<boolean> {
    if (expectedCommand) {
      const output = await readExecStdout(
        `ps -p ${pid} -o cmd= | grep -F '${expectedCommand}' && echo alive`
      );
      return output === 'alive';
    }

    const output = await readExecStdout(`ps -p ${pid} -o pid=`);
    return output.includes(String(pid));
  }

  test('should return error when killing nonexistent process', async () => {
    const killResponse = await fetch(
      `${workerUrl}/api/process/fake-process-id-12345`,
      {
        method: 'DELETE',
        headers
      }
    );

    expect(killResponse.status).toBe(500);
    const errorData = (await killResponse.json()) as { error: string };
    expect(errorData.error).toBeTruthy();
    expect(errorData.error).toMatch(
      /not found|does not exist|invalid|unknown/i
    );
  }, 90000);

  test('should capture PID and logs immediately for fast commands', async () => {
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "Hello from process"'
      })
    });

    expect(startResponse.status).toBe(200);
    const startData = (await startResponse.json()) as Process;
    const processId = startData.id;

    // PID should be available immediately
    expect(startData.pid).toBeDefined();
    expect(typeof startData.pid).toBe('number');

    // Logs should be available immediately for fast commands
    const logsResponse = await fetch(
      `${workerUrl}/api/process/${processId}/logs`,
      {
        method: 'GET',
        headers
      }
    );

    expect(logsResponse.status).toBe(200);
    const logsData = (await logsResponse.json()) as ProcessLogsResult;
    expect(logsData.stdout).toContain('Hello from process');
  }, 90000);

  test('should terminate the full background process tree when killed', async () => {
    const token = `kill-tree-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const scriptPath = `/workspace/${token}.sh`;
    const pidFilePath = `/workspace/${token}.pid`;
    const scriptCode = `#!/usr/bin/env bash
sleep 120 &
echo "$!" > '${pidFilePath}'
wait`;
    let processId: string | null = null;
    let childPid: number | null = null;

    try {
      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: scriptPath,
          content: scriptCode
        })
      });

      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `bash '${scriptPath}'`
        })
      });

      expect(startResponse.status).toBe(200);
      const processData = (await startResponse.json()) as Process;
      processId = processData.id;

      childPid = await waitForChildPid(pidFilePath);

      const killResponse = await fetch(
        `${workerUrl}/api/process/${processId}`,
        {
          method: 'DELETE',
          headers
        }
      );
      expect(killResponse.status).toBe(200);

      await waitForProcessExit(processId);

      for (let i = 0; i < 20; i++) {
        if (childPid && !(await isProcessAlive(childPid))) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      if (processId) {
        await fetch(`${workerUrl}/api/process/${processId}`, {
          method: 'DELETE',
          headers
        }).catch(() => {});
      }

      if (childPid) {
        await readExecStdout(
          `kill -9 ${childPid} 2>/dev/null || true; rm -f '${pidFilePath}'`
        ).catch(() => {});
      } else {
        await readExecStdout(`rm -f '${pidFilePath}'`).catch(() => {});
      }

      await readExecStdout(`rm -f '${scriptPath}'`).catch(() => {});
    }

    if (childPid) {
      expect(await isProcessAlive(childPid)).toBe(false);
    }
  }, 90000);

  test('should stream process logs in real-time', async () => {
    // Write a script that outputs multiple lines
    const scriptCode = `
console.log("Line 1");
await Bun.sleep(100);
console.log("Line 2");
await Bun.sleep(100);
console.log("Line 3");
    `.trim();

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '/workspace/script.js',
        content: scriptCode
      })
    });

    // Start the script
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'bun run /workspace/script.js'
      })
    });

    const startData = (await startResponse.json()) as Process;
    const processId = startData.id;

    // Stream logs (SSE)
    const streamResponse = await fetch(
      `${workerUrl}/api/process/${processId}/stream`,
      {
        method: 'GET',
        headers
      }
    );

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toBe(
      'text/event-stream'
    );

    // Collect events from the stream
    const reader = streamResponse.body?.getReader();
    const decoder = new TextDecoder();
    const events: any[] = [];

    if (reader) {
      let done = false;
      const timeout = Date.now() + 10000; // 10s timeout

      while (!done && Date.now() < timeout) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;

        if (value) {
          const chunk = decoder.decode(value);
          const lines = chunk
            .split('\n\n')
            .filter((line) => line.startsWith('data: '));

          for (const line of lines) {
            const eventData = line.replace('data: ', '');
            try {
              events.push(JSON.parse(eventData));
            } catch (e) {
              // Skip malformed events
            }
          }
        }

        // Stop after collecting some events
        if (events.length >= 3) {
          reader.cancel();
          break;
        }
      }
    }
  }, 90000);

  test.skipIf(skipPortExposureTests)(
    'should reject exposing reserved ports',
    async () => {
      const exposeResponse = await fetch(`${workerUrl}/api/port/expose`, {
        method: 'POST',
        headers: portHeaders,
        body: JSON.stringify({
          port: 22,
          name: 'ssh-server'
        })
      });

      expect(exposeResponse.status).toBeGreaterThanOrEqual(400);
      const errorData = (await exposeResponse.json()) as { error: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(
        /reserved|not allowed|forbidden|invalid port/i
      );
    },
    90000
  );

  test.skipIf(skipPortExposureTests)(
    'should return error when unexposing non-exposed port',
    async () => {
      const unexposeResponse = await fetch(
        `${workerUrl}/api/exposed-ports/${PORT_LIFECYCLE_TEST_PORT}`,
        {
          method: 'DELETE',
          headers: portHeaders
        }
      );

      expect(unexposeResponse.status).toBe(500);
      const errorData = (await unexposeResponse.json()) as { error: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(/not found|not exposed|does not exist/i);
    },
    90000
  );

  test('should not block foreground operations when background processes are running', async () => {
    // Start a long-running background process
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'sleep 60'
      })
    });

    const startData = (await startResponse.json()) as Process;
    const processId = startData.id;

    // Immediately run a foreground command - should complete quickly
    const execStart = Date.now();
    const execResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "test"'
      })
    });
    const execDuration = Date.now() - execStart;

    expect(execResponse.status).toBe(200);
    expect(execDuration).toBeLessThan(2000); // Should complete in <2s

    // Cleanup
    await fetch(`${workerUrl}/api/process/${processId}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);
});
