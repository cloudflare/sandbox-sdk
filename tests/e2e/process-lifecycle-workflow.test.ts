import type { ExecResult, Process, ProcessLogsResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
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
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;
  let portHeaders: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
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

  async function isProcessAlive(pid: number): Promise<boolean> {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `if ! kill -0 ${pid} 2>/dev/null; then echo dead; elif [ -r /proc/${pid}/status ] && grep -q '^State:[[:space:]]*Z' /proc/${pid}/status; then echo dead; else echo alive; fi`
      })
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ExecResult;
    return result.stdout.trim() === 'alive';
  }

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should return error when killing nonexistent process', async () => {
    const killResponse = await fetch(
      `${workerUrl}/api/process/fake-process-id-12345`,
      {
        method: 'DELETE',
        headers
      }
    );

    expect(killResponse.status).toBe(404);
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
    const bashPidFile = `/workspace/${token}-bash.pid`;
    const sleepPidFile = `/workspace/${token}-sleep.pid`;
    // Capture the bash PID AND the leaf sleep PID so we can verify
    // both the shell wrapper and the actual child are terminated.
    const scriptCode = `#!/usr/bin/env bash
echo "$$" > '${bashPidFile}'
sleep 120 &
echo "$!" > '${sleepPidFile}'
wait`;
    let processId: string | null = null;
    let bashPid: number | null = null;
    let sleepPid: number | null = null;

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

      [bashPid, sleepPid] = await Promise.all([
        waitForChildPid(bashPidFile),
        waitForChildPid(sleepPidFile)
      ]);

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
        const [bashAlive, sleepAlive] = await Promise.all([
          isProcessAlive(bashPid),
          isProcessAlive(sleepPid)
        ]);
        if (!bashAlive && !sleepAlive) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      if (processId) {
        await fetch(`${workerUrl}/api/process/${processId}`, {
          method: 'DELETE',
          headers
        }).catch(() => {});
      }

      const pidsToKill = [bashPid, sleepPid].filter(Boolean);
      for (const p of pidsToKill) {
        await readExecStdout(`kill -9 ${p} 2>/dev/null || true`).catch(
          () => {}
        );
      }
      await readExecStdout(
        `rm -f '${bashPidFile}' '${sleepPidFile}' '${scriptPath}'`
      ).catch(() => {});
    }

    expect(bashPid).not.toBeNull();
    expect(sleepPid).not.toBeNull();
    // Both the shell wrapper AND the leaf sleep process must be dead
    expect(await isProcessAlive(bashPid!)).toBe(false);
    expect(await isProcessAlive(sleepPid!)).toBe(false);

    // Verify the process record reports 'killed' status
    const statusResponse = await fetch(
      `${workerUrl}/api/process/${processId}`,
      { method: 'GET', headers }
    );
    expect(statusResponse.ok).toBe(true);
    const record = (await statusResponse.json()) as Process;
    expect(record.status).toBe('killed');
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

      expect(unexposeResponse.status).toBe(404);
      const errorData = (await unexposeResponse.json()) as { error: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error).toMatch(/not found|not exposed|does not exist/i);
    },
    90000
  );

  test('should kill all levels of a deep process tree', async () => {
    const token = `deep-tree-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const pid1File = `/workspace/${token}-l1.pid`;
    const pid2File = `/workspace/${token}-l2.pid`;
    const pid3File = `/workspace/${token}-l3.pid`;
    const sleepPidFile = `/workspace/${token}-sleep.pid`;
    const scriptPath = `/workspace/${token}.sh`;
    const innerPath = `/workspace/${token}-inner.sh`;

    // Level 3 now also captures the actual leaf sleep PID
    const innerCode = [
      '#!/usr/bin/env bash',
      `echo "$$" > '${pid2File}'`,
      `bash -c 'echo "$$" > '"'"'${pid3File}'"'"'; sleep 120 & echo "$!" > '"'"'${sleepPidFile}'"'"'; wait'`
    ].join('\n');

    const scriptCode = [
      '#!/usr/bin/env bash',
      `echo "$$" > '${pid1File}'`,
      `bash '${innerPath}'`
    ].join('\n');

    let processId: string | null = null;
    let pids: number[] = [];

    try {
      await Promise.all([
        fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: scriptPath, content: scriptCode })
        }),
        fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: innerPath, content: innerCode })
        })
      ]);

      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `bash '${scriptPath}'` })
      });
      expect(startResponse.status).toBe(200);
      const processData = (await startResponse.json()) as Process;
      processId = processData.id;

      const [pid1, pid2, pid3, sleepPid] = await Promise.all([
        waitForChildPid(pid1File),
        waitForChildPid(pid2File),
        waitForChildPid(pid3File),
        waitForChildPid(sleepPidFile)
      ]);
      pids = [pid1, pid2, pid3, sleepPid];

      const killResponse = await fetch(
        `${workerUrl}/api/process/${processId}`,
        { method: 'DELETE', headers }
      );
      expect(killResponse.status).toBe(200);

      await waitForProcessExit(processId);

      for (let i = 0; i < 20; i++) {
        const aliveResults = await Promise.all(
          pids.map((p) => isProcessAlive(p))
        );
        if (aliveResults.every((alive) => !alive)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      if (processId) {
        await fetch(`${workerUrl}/api/process/${processId}`, {
          method: 'DELETE',
          headers
        }).catch(() => {});
      }
      for (const f of [
        pid1File,
        pid2File,
        pid3File,
        sleepPidFile,
        scriptPath,
        innerPath
      ]) {
        await readExecStdout(`rm -f '${f}'`).catch(() => {});
      }
    }

    // All levels including the leaf sleep process must be dead
    for (const pid of pids) {
      expect(await isProcessAlive(pid)).toBe(false);
    }
  }, 90000);

  test('should kill all background processes concurrently and verify pids are dead', async () => {
    const token = `kill-all-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const pidFiles = [0, 1, 2].map((i) => `/workspace/${token}-${i}.pid`);
    const scriptPaths = [0, 1, 2].map((i) => `/workspace/${token}-${i}.sh`);
    const processIds: string[] = [];
    const pids: number[] = [];

    try {
      for (let i = 0; i < 3; i++) {
        const scriptCode = `#!/usr/bin/env bash\necho "$$" > '${pidFiles[i]}'\nsleep 120`;
        await fetch(`${workerUrl}/api/file/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: scriptPaths[i], content: scriptCode })
        });

        const startResponse = await fetch(`${workerUrl}/api/process/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ command: `bash '${scriptPaths[i]}'` })
        });
        expect(startResponse.status).toBe(200);
        const processData = (await startResponse.json()) as Process;
        processIds.push(processData.id);
      }

      for (const pidFile of pidFiles) {
        pids.push(await waitForChildPid(pidFile));
      }

      const killAllResponse = await fetch(`${workerUrl}/api/process/kill-all`, {
        method: 'DELETE',
        headers
      });
      expect(killAllResponse.status).toBe(200);

      for (let i = 0; i < 20; i++) {
        const aliveResults = await Promise.all(
          pids.map((p) => isProcessAlive(p))
        );
        if (aliveResults.every((alive) => !alive)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      for (let i = 0; i < 3; i++) {
        await fetch(`${workerUrl}/api/process/${processIds[i]}`, {
          method: 'DELETE',
          headers
        }).catch(() => {});
        await readExecStdout(
          `rm -f '${pidFiles[i]}' '${scriptPaths[i]}'`
        ).catch(() => {});
      }
    }

    for (const pid of pids) {
      expect(await isProcessAlive(pid)).toBe(false);
    }
  }, 90000);

  test('should escalate to SIGKILL when process traps SIGTERM', async () => {
    const token = `sigterm-trap-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const scriptPath = `/workspace/${token}.sh`;
    const pidFile = `/workspace/${token}.pid`;
    // The script traps (ignores) SIGTERM and uses a pure-bash busy wait
    // so no child processes are spawned. This ensures the root process
    // itself survives SIGTERM and can only be killed via SIGKILL.
    const scriptCode = `#!/usr/bin/env bash
trap "" SIGTERM
echo "$$" > '${pidFile}'
while :; do :; done`;
    let processId: string | null = null;
    let pid: number | null = null;

    try {
      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: scriptPath, content: scriptCode })
      });

      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `bash '${scriptPath}'` })
      });
      expect(startResponse.status).toBe(200);
      const processData = (await startResponse.json()) as Process;
      processId = processData.id;

      pid = await waitForChildPid(pidFile);

      const killStart = Date.now();
      const killResponse = await fetch(
        `${workerUrl}/api/process/${processId}`,
        { method: 'DELETE', headers }
      );
      expect(killResponse.status).toBe(200);

      await waitForProcessExit(processId, 15000);
      const killDuration = Date.now() - killStart;

      // The kill should take at least ~5 seconds (the SIGTERM grace period)
      // before escalating to SIGKILL.
      expect(killDuration).toBeGreaterThanOrEqual(4000);

      for (let i = 0; i < 20; i++) {
        if (pid && !(await isProcessAlive(pid))) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      if (processId) {
        await fetch(`${workerUrl}/api/process/${processId}`, {
          method: 'DELETE',
          headers
        }).catch(() => {});
      }
      if (pid) {
        await readExecStdout(`kill -9 ${pid} 2>/dev/null || true`).catch(
          () => {}
        );
      }
      await readExecStdout(`rm -f '${pidFile}' '${scriptPath}'`).catch(
        () => {}
      );
    }

    expect(pid).not.toBeNull();
    expect(await isProcessAlive(pid!)).toBe(false);

    // Verify the process record reports 'killed' status with exit code 137
    const statusResponse = await fetch(
      `${workerUrl}/api/process/${processId}`,
      { method: 'GET', headers }
    );
    expect(statusResponse.ok).toBe(true);
    const record = (await statusResponse.json()) as Process;
    expect(record.status).toBe('killed');
    expect(record.exitCode).toBe(137);
  }, 90000);

  test('should kill background processes when their session is destroyed', async () => {
    const sessionId = createUniqueSession();
    const sessionHeaders = sandbox!.headers(sessionId);
    const token = `session-destroy-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const pidFile = `/workspace/${token}.pid`;
    const scriptPath = `/workspace/${token}.sh`;
    const scriptCode = `#!/usr/bin/env bash\necho "$$" > '${pidFile}'\nsleep 120`;
    let pid: number | null = null;

    try {
      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ path: scriptPath, content: scriptCode })
      });

      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ command: `bash '${scriptPath}'` })
      });
      expect(startResponse.status).toBe(200);

      // The PID file is written in the shared workspace, so the helper can read it
      // without using the session-specific headers from the process start request.
      pid = await waitForChildPid(pidFile, 10000);

      const deleteResponse = await fetch(`${workerUrl}/api/session/delete`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ sessionId })
      });
      expect(deleteResponse.status).toBe(200);

      for (let i = 0; i < 20; i++) {
        if (pid && !(await isProcessAlive(pid))) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      await readExecStdout(`rm -f '${pidFile}' '${scriptPath}'`).catch(
        () => {}
      );
    }

    expect(pid).not.toBeNull();
    expect(await isProcessAlive(pid!)).toBe(false);
  }, 90000);

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
    expect(execDuration).toBeLessThan(4000); // Should complete quickly

    // Cleanup
    await fetch(`${workerUrl}/api/process/${processId}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);
});
