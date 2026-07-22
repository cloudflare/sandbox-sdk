import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { stopContainerAndWait } from './helpers/container-lifecycle';
import {
  cleanupSandbox,
  createSandboxId,
  createTestHeaders,
  sleep
} from './helpers/test-fixtures';

interface ProcessStatus {
  id: string;
  state: 'running' | 'exited' | 'error';
  exit?: { code: number; timedOut: boolean; signal?: number };
}

interface ByteLogEvent {
  type: 'stdout' | 'stderr';
  cursor: string;
  data: number[];
}

interface TerminalEvent {
  type: 'terminal';
  cursor: string;
  exit: { code: number; timedOut: boolean; signal?: number };
}

interface TerminalDataEvent {
  type: 'data';
  cursor: string;
  data: number[];
}

type LogEvent =
  | ByteLogEvent
  | TerminalDataEvent
  | TerminalEvent
  | { type: 'truncated'; cursor?: string };

function textFrom(events: LogEvent[]): string {
  const decoder = new TextDecoder();
  return events
    .filter(
      (event): event is ByteLogEvent | TerminalDataEvent =>
        event.type === 'stdout' ||
        event.type === 'stderr' ||
        event.type === 'data'
    )
    .map((event) => decoder.decode(new Uint8Array(event.data)))
    .join('');
}

describe('coding agent process workflows', () => {
  let workerUrl: string;
  let sandboxId: string;
  let headers: Record<string, string>;

  beforeEach(() => {
    workerUrl = process.env.TEST_WORKER_URL || 'http://localhost:8787';
    sandboxId = createSandboxId();
    headers = createTestHeaders(sandboxId);
  });

  afterEach(async () => {
    await cleanupSandbox(workerUrl, sandboxId);
  }, 120000);

  async function post<T>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(`${workerUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as T;
  }

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${workerUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(30000)
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as T;
  }

  test('Pi shape: bash argv, byte logs, wait, and tree-safe abort', async () => {
    const script =
      'printf pi-out; printf pi-err >&2; sleep 60 & child=$!; echo child:$child; wait';
    const started = await post<ProcessStatus>('/api/process/start', {
      command: ['/bin/bash', '-lc', script]
    });

    await post(`/api/process/${started.id}/wait-for-log`, {
      pattern: 'child:',
      timeout: 10000
    });
    await post(`/api/process/${started.id}/kill`, { signal: 15 });
    const exit = await post<{ code: number }>(
      `/api/process/${started.id}/wait`,
      {
        timeout: 10000
      }
    );
    expect(exit.code).not.toBe(0);

    const logs = await get<{ events: LogEvent[] }>(
      `/api/process/${started.id}/logs`
    );
    expect(textFrom(logs.events)).toContain('pi-out');
    expect(textFrom(logs.events)).toContain('pi-err');
    expect(logs.events.at(-1)?.type).toBe('terminal');

    const pgrep = await post<{ stdout: string }>('/api/execute', {
      command: ['/bin/bash', '-lc', "pgrep -f '[s]leep 60' || true"]
    });
    expect(pgrep.stdout.trim()).toBe('');
  }, 45000);

  test('canceling followed logs after output leaves the process running', async () => {
    const result = await post<{
      output: string;
      stateAfterCancel: string;
      exitCode: number;
    }>('/api/process/log-follow-cancel-regression', {});

    expect(result.output).toContain('follow-ready');
    expect(result.stateAfterCancel).toBe('running');
    expect(result.exitCode).not.toBe(0);
  }, 30000);

  test('issue #764: aborting wait stays local and leaves the process running', async () => {
    const result = await post<{
      waitRejected: boolean;
      dataCloneError: boolean;
      stateAfterAbort: string;
      exitCode: number;
    }>('/api/process/abort-wait-regression', {});

    expect(result).toMatchObject({
      waitRejected: true,
      dataCloneError: false,
      stateAfterAbort: 'running'
    });
    expect(result.exitCode).not.toBe(0);
  }, 30000);

  test('non-waking discovery and runtime fencing reject stale handles', async () => {
    const result = await post<{
      stoppedListCount: number;
      stoppedGetFound: boolean;
      staleRejected: boolean;
      staleReasonMatched: boolean;
      racingRejected: boolean;
      racingCode: string | null;
    }>('/api/process/runtime-fencing-regression', {});

    expect(result).toMatchObject({
      stoppedListCount: 0,
      stoppedGetFound: false,
      staleRejected: true,
      staleReasonMatched: true,
      racingRejected: true
    });
    expect(['OPERATION_INTERRUPTED', 'RPC_TRANSPORT_ERROR']).toContain(
      result.racingCode
    );
  }, 60000);

  test('Codex shape: process ID is usable across requests for logs, status, and exit', async () => {
    const started = await post<ProcessStatus>('/api/process/start', {
      command: [
        '/bin/bash',
        '-lc',
        'echo build-start; sleep 1; echo build-done'
      ]
    });
    expect(started.state).toBe('running');

    await post(`/api/process/${started.id}/wait-for-log`, {
      pattern: 'build-start',
      timeout: 10000
    });
    const during = await get<ProcessStatus>(`/api/process/${started.id}`);
    expect(during.id).toBe(started.id);

    const exit = await post<{ code: number }>(
      `/api/process/${started.id}/wait`,
      {
        timeout: 10000
      }
    );
    expect(exit.code).toBe(0);
    const logs = await get<{ events: LogEvent[] }>(
      `/api/process/${started.id}/logs`
    );
    expect(textFrom(logs.events)).toContain('build-done');
  }, 30000);

  test('process logs support cursors, truncation, readiness, servers, parallel files, and runtime replacement', async () => {
    const first = await post<ProcessStatus>('/api/process/start', {
      command: ['/bin/bash', '-lc', 'printf first; sleep 1; printf second']
    });
    await post(`/api/process/${first.id}/wait-for-log`, {
      pattern: 'first',
      timeout: 10000
    });
    const firstLogs = await get<{ events: LogEvent[] }>(
      `/api/process/${first.id}/logs`
    );
    const cursor = firstLogs.events.find((event) => 'cursor' in event)?.cursor;
    expect(cursor).toBeTruthy();
    await post(`/api/process/${first.id}/wait`, { timeout: 10000 });
    const laterLogs = await get<{ events: LogEvent[] }>(
      `/api/process/${first.id}/logs?since=${encodeURIComponent(cursor ?? '')}`
    );
    expect(textFrom(laterLogs.events)).toContain('second');

    const noisy = await post<ProcessStatus>('/api/process/start', {
      command: [
        '/bin/bash',
        '-lc',
        'printf start; sleep 1; yes truncate-me | head -c 2000000'
      ]
    });
    await post(`/api/process/${noisy.id}/wait-for-log`, {
      pattern: 'start',
      timeout: 10000
    });
    const noisyHead = await get<{ events: LogEvent[] }>(
      `/api/process/${noisy.id}/logs`
    );
    const noisyCursor = noisyHead.events.find(
      (event) => 'cursor' in event
    )?.cursor;
    await post(`/api/process/${noisy.id}/wait`, { timeout: 10000 });
    const truncated = await get<{ events: LogEvent[] }>(
      `/api/process/${noisy.id}/logs?since=${encodeURIComponent(noisyCursor ?? '')}`
    );
    expect(truncated.events.some((event) => event.type === 'truncated')).toBe(
      true
    );

    const server = await post<ProcessStatus>('/api/process/start', {
      command: [
        '/bin/bash',
        '-lc',
        'cat > /tmp/task11-server.js <<\'JS\'\nBun.serve({ port: 9134, fetch() { return new Response("ready"); } });\nconsole.log("server-ready");\nawait new Promise(() => {});\nJS\nbun /tmp/task11-server.js'
      ]
    });
    await post(`/api/process/${server.id}/wait-for-log`, {
      pattern: 'server-ready',
      timeout: 10000
    });
    await post(`/api/process/${server.id}/wait-for-port`, {
      port: 9134,
      timeout: 10000
    });
    const curl = await post<{ stdout: string }>('/api/execute', {
      command: ['/bin/bash', '-lc', 'curl -s http://localhost:9134']
    });
    expect(curl.stdout).toContain('ready');
    await post(`/api/process/${server.id}/kill`, { signal: 15 });
    const serverExit = await post<{ code: number }>(
      `/api/process/${server.id}/wait`,
      { timeout: 10000 }
    );
    expect(serverExit.code).not.toBe(0);

    const file = `/workspace/task11-parallel-${Date.now()}`;
    const [a, b] = await Promise.all([
      post<ProcessStatus>('/api/process/start', {
        command: ['/bin/bash', '-lc', `printf A >> ${file}`]
      }),
      post<ProcessStatus>('/api/process/start', {
        command: ['/bin/bash', '-lc', `printf B >> ${file}`]
      })
    ]);
    await Promise.all([
      post(`/api/process/${a.id}/wait`, { timeout: 10000 }),
      post(`/api/process/${b.id}/wait`, { timeout: 10000 })
    ]);
    const combined = await post<{ stdout: string }>('/api/execute', {
      command: ['/bin/bash', '-lc', `cat ${file}`]
    });
    expect(combined.stdout).toContain('A');
    expect(combined.stdout).toContain('B');

    const oldRuntimeProcess = await post<ProcessStatus>('/api/process/start', {
      command: ['/bin/bash', '-lc', 'sleep 300']
    });
    await stopContainerAndWait(workerUrl, headers, { timeoutMs: 30000 });
    const restarted = await post<{ stdout: string }>('/api/execute', {
      command: ['/bin/bash', '-lc', 'printf restarted']
    });
    expect(restarted.stdout).toBe('restarted');

    const staleProcessResponse = await fetch(
      `${workerUrl}/api/process/${oldRuntimeProcess.id}`,
      { headers, signal: AbortSignal.timeout(30000) }
    );
    expect(staleProcessResponse.status).toBe(404);
  }, 90000);

  test('OpenCode shape: PTY output cursor reconnect observes later output', async () => {
    const terminal = await post<{ id: string }>('/api/terminal/create', {
      command: ['/bin/bash'],
      cols: 80,
      rows: 24
    });
    await post(`/api/terminal/${terminal.id}/write`, { data: 'echo first\n' });
    await sleep(500);
    const first = await get<{ events: LogEvent[] }>(
      `/api/terminal/${terminal.id}/output`
    );
    let cursor: string | undefined;
    for (const event of first.events) {
      if ('cursor' in event) cursor = event.cursor;
    }
    expect(textFrom(first.events)).toContain('first');
    expect(cursor).toBeTruthy();

    await post(`/api/terminal/${terminal.id}/resize`, { cols: 100, rows: 30 });
    await post(`/api/terminal/${terminal.id}/write`, {
      data: 'stty size; echo second\n'
    });
    await sleep(500);
    const second = await get<{ events: LogEvent[] }>(
      `/api/terminal/${terminal.id}/output?since=${encodeURIComponent(cursor ?? '')}`
    );
    expect(textFrom(second.events)).toContain('30 100');
    expect(textFrom(second.events)).toContain('second');
    await post(`/api/terminal/${terminal.id}/terminate`, {});
  }, 30000);
});
