import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import { createTestHeaders } from './helpers/test-fixtures';

interface ProcessStatus {
  id: string;
  state: 'running' | 'exited' | 'error';
  exit?: { code: number; timedOut: boolean; signal?: number };
}

interface ProcessExit {
  code: number;
  timedOut: boolean;
  signal?: number;
}

interface ProcessLogEvent {
  type: 'stdout' | 'stderr' | 'terminal' | 'truncated';
  exit?: ProcessExit;
}

async function waitForChildMarker(
  workerUrl: string,
  sandboxId: string,
  marker: string,
  timeoutMs = 5000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        command: [
          '/bin/bash',
          '-lc',
          `pid=$(cat ${marker} 2>/dev/null || true); case "$pid" in ''|*[!0-9]*) exit 1;; *) printf '%s' "$pid";; esac`
        ]
      })
    });
    if (response.ok) {
      const result = (await response.json()) as { stdout: string };
      const pid = Number(result.stdout.trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for child PID marker ${marker}`);
}

async function timedFetch(
  label: string,
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const start = Date.now();
  const response = await fetch(...args);
  console.log(
    `[timeout-test] ${label}: ${Date.now() - start}ms (${response.status})`
  );
  return response;
}

describe('Command Timeout', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let sandboxId: string;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    sandboxId = sandbox.sandboxId;
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('process timeout kills leader and descendants with stable terminal exit', async () => {
    const marker = `/tmp/task11-timeout-${Date.now()}`;
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', `sleep 30 & echo $! > ${marker}; wait`],
        timeout: 1000
      })
    });
    expect(startResponse.status).toBe(200);
    const started = (await startResponse.json()) as ProcessStatus;
    const childPid = await waitForChildMarker(workerUrl, sandboxId, marker);
    expect(childPid).toBeGreaterThan(0);

    const exitResponse = await timedFetch(
      'process wait timeout',
      `${workerUrl}/api/process/${started.id}/wait`,
      {
        method: 'POST',
        headers: createTestHeaders(sandboxId),
        body: JSON.stringify({ timeout: 15000 })
      }
    );
    expect(exitResponse.status).toBe(200);
    const exit = (await exitResponse.json()) as ProcessExit;
    expect(exit.timedOut).toBe(true);
    expect(exit.code).not.toBe(0);

    const laterResponse = await fetch(
      `${workerUrl}/api/process/${started.id}`,
      {
        headers: createTestHeaders(sandboxId)
      }
    );
    expect(laterResponse.status).toBe(200);
    const later = (await laterResponse.json()) as ProcessStatus;
    expect(later.state).toBe('exited');
    expect(later.exit?.timedOut).toBe(true);

    const logsResponse = await fetch(
      `${workerUrl}/api/process/${started.id}/logs`,
      { headers: createTestHeaders(sandboxId) }
    );
    expect(logsResponse.status).toBe(200);
    const logs = (await logsResponse.json()) as { events: ProcessLogEvent[] };
    expect(logs.events.at(-1)?.type).toBe('terminal');
    expect(logs.events.at(-1)?.exit?.timedOut).toBe(true);

    const childResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: createTestHeaders(sandboxId),
      body: JSON.stringify({
        command: [
          '/bin/bash',
          '-lc',
          `pid=$(cat ${marker}); if [ "$pid" = "${childPid}" ] && kill -0 "$pid" 2>/dev/null; then echo alive; fi`
        ]
      })
    });
    expect(childResponse.status).toBe(200);
    const child = (await childResponse.json()) as { stdout: string };
    expect(child.stdout.trim()).toBe('');
  }, 60000);

  test('sandbox.exec should respect per-command timeout', async () => {
    const startTime = Date.now();
    const response = await timedFetch(
      'test1 exec',
      `${workerUrl}/api/execute`,
      {
        method: 'POST',
        headers: createTestHeaders(sandboxId),
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'sleep 30'],
          timeout: 1000
        })
      }
    );
    const elapsed = Date.now() - startTime;

    expect(response.status).toBe(200);
    const data = (await response.json()) as CommandResponse;
    expect(data.success).toBe(false);
    expect(data.exitCode).not.toBe(0);
    expect(data.signal).toBeGreaterThan(0);
    expect(data.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(15000);
  }, 60000);
});
