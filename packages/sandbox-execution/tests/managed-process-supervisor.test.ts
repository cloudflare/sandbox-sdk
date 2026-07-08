import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ManagedProcessSupervisor, type RuntimeManagedProcess } from '../src';
import { setManagedProcessSupervisorTestHooks } from '../src/process/managed-process-supervisor';
import {
  isPidRunning,
  isProcessGroupRunning,
  signalProcessTree
} from '../src/process/process-tree';
import * as signalModule from '../src/process/signals';
import {
  type DrainCancellation,
  drainReadableStream
} from '../src/process/stream-drain';

afterEach(() => setManagedProcessSupervisorTestHooks());

describe('stream draining', () => {
  test('uses one released cancellation subscription for sustained output', async () => {
    let subscriptions = 0;
    let releases = 0;
    const cancellation: DrainCancellation = {
      aborted: false,
      subscribe: () => {
        subscriptions++;
        return () => {
          releases++;
        };
      }
    };
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks === 10_000) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array([chunks++ % 256]));
      }
    });

    let appended = 0;
    await drainReadableStream(stream, () => appended++, cancellation);

    expect(appended).toBe(10_000);
    expect(subscriptions).toBe(1);
    expect(releases).toBe(1);
    expect(stream.locked).toBe(false);
  });
});

describe('ManagedProcessSupervisor', () => {
  test('launches exact argv without shell interpolation or dropped empty entries', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'argv',
      command: [
        '/bin/bash',
        '-lc',
        'printf "%s:%s:%s" "$1" "$2" "$3"',
        'argv0',
        '$HOME',
        '',
        'tail'
      ]
    });
    await waitForOutput(process, '$HOME::tail');
    expect(await process.waitForExit()).toMatchObject({
      command: [
        '/bin/bash',
        '-lc',
        'printf "%s:%s:%s" "$1" "$2" "$3"',
        'argv0',
        '$HOME',
        '',
        'tail'
      ],
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
  });

  test('rejects empty argv and empty argv[0]', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    await expect(
      // @ts-expect-error Runtime validation rejects empty argv from untyped callers.
      supervisor.start({ runId: 'empty', command: [] })
    ).rejects.toThrow('Command must not be empty');
    await expect(
      supervisor.start({ runId: 'empty-executable', command: [''] })
    ).rejects.toThrow('Command executable must not be empty');
  });

  test('applies cwd and environment overlay', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'cwd-env',
      command: ['bash', '-c', 'printf "%s:%s" "$PWD" "$VALUE"'],
      cwd: '/tmp',
      env: { VALUE: 'overlay' }
    });
    await waitForOutput(process, '/tmp:overlay');
    expect((await process.waitForExit()).cwd).toBe('/tmp');
  });

  test('records arbitrary stdout and stderr bytes', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'bytes',
      command: ['bash', '-c', "printf '\\377'; printf err >&2"]
    });
    await Promise.all([
      waitForOutput(process, new Uint8Array([255])),
      waitForOutput(process, new TextEncoder().encode('err'))
    ]);
    expect((await process.waitForExit()).state).toBe('exited');
  });

  test('reports observed terminal outcomes instead of requested signals', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const termKilled = await supervisor.start({
      runId: 'term-killed',
      command: ['sleep', '30']
    });
    await termKilled.kill();
    expect(await termKilled.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 143, signal: 15, timedOut: false }
    });

    const killKilled = await supervisor.start({
      runId: 'kill-killed',
      command: ['sleep', '30']
    });
    await killKilled.kill(9);
    expect(await killKilled.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 137, signal: 9, timedOut: false }
    });

    const handledTerm = await supervisor.start({
      runId: 'handled-term',
      command: [
        '/bin/bash',
        '-lc',
        "trap 'exit 0' TERM; echo ready; while :; do sleep 1; done"
      ]
    });
    await waitForOutput(handledTerm, 'ready');
    await handledTerm.kill();
    const handled = await handledTerm.waitForExit();
    expect(handled).toMatchObject({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    if (handled.state !== 'exited') throw new Error('Expected exit');
    expect(handled.exit.signal).toBeUndefined();
  });

  test('kill defaults to TERM and accepts every integer signal from 1 through 64', async () => {
    const delivered: number[] = [];
    setManagedProcessSupervisorTestHooks({
      signal: async (pid, signal) => {
        delivered.push(signal);
        await signalProcessTree(pid, 9);
      }
    });

    const defaultSupervisor = new ManagedProcessSupervisor();
    const defaultProcess = await defaultSupervisor.start({
      runId: 'default-signal',
      command: ['sleep', '30']
    });
    await defaultProcess.kill();
    await defaultProcess.waitForExit();
    await defaultSupervisor.close();

    for (let signal = 1; signal <= 64; signal++) {
      const supervisor = new ManagedProcessSupervisor();
      const process = await supervisor.start({
        runId: `signal-${signal}`,
        command: ['sleep', '30']
      });
      await process.kill(signal);
      await process.waitForExit();
      await supervisor.close();
    }

    expect(delivered).toEqual([
      15,
      ...Array.from({ length: 64 }, (_, i) => i + 1)
    ]);
  });

  test('kill rejects invalid signals before signaling', async () => {
    const delivered: number[] = [];
    setManagedProcessSupervisorTestHooks({
      signal: async (_pid, signal) => {
        delivered.push(signal);
      }
    });
    const supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'invalid-signal',
      command: ['sleep', '30']
    });

    for (const signal of [0, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(process.kill(signal)).rejects.toThrow(
        'signal must be an integer from 1 through 64'
      );
    }
    expect(delivered).toEqual([]);

    setManagedProcessSupervisorTestHooks();
    await signalProcessTree(process.pid, 9);
    await process.waitForExit();
    await supervisor.close();
  });

  test('kill resolves after delivery instead of waiting for exit', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'delivery-ack',
      command: [
        '/bin/bash',
        '-lc',
        "trap 'sleep 0.5; exit 0' TERM; echo ready; while :; do sleep 1; done"
      ]
    });
    await waitForOutput(process, 'ready');

    const started = Date.now();
    await process.kill();
    expect(Date.now() - started).toBeLessThan(400);
    expect(process.snapshot().state).toBe('running');
    expect(await process.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
  });

  test('public kill cleans inherited-pipe descendants after leader exit', async () => {
    let leaderExitedResolve: () => void = () => {};
    const leaderExited = new Promise<void>((resolve) => {
      leaderExitedResolve = resolve;
    });
    setManagedProcessSupervisorTestHooks({ exitSettled: leaderExitedResolve });
    await using supervisor = new ManagedProcessSupervisor();
    const managed = await supervisor.start({
      runId: 'inherited-pipe-public-kill',
      command: ['/bin/bash', '-lc', 'sleep 30 &']
    });

    await leaderExited;
    expect(managed.snapshot().state).toBe('running');
    await managed.kill(9);
    expect(await managed.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    expect(isProcessGroupRunning(managed.pid)).toBe(false);
  });

  test('lifetime timeout cleans inherited-pipe descendants after leader exit', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const managed = await supervisor.start({
      runId: 'inherited-pipe-timeout',
      command: ['/bin/bash', '-lc', 'sleep 30 &'],
      timeoutMs: 50
    });

    expect(await managed.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 0, timedOut: true }
    });
    expect(isProcessGroupRunning(managed.pid)).toBe(false);
  });

  test('supervisor close cleans inherited-pipe descendants after leader exit', async () => {
    let leaderExitedResolve: () => void = () => {};
    const leaderExited = new Promise<void>((resolve) => {
      leaderExitedResolve = resolve;
    });
    setManagedProcessSupervisorTestHooks({ exitSettled: leaderExitedResolve });
    const supervisor = new ManagedProcessSupervisor();
    const managed = await supervisor.start({
      runId: 'inherited-pipe-close',
      command: ['/bin/bash', '-lc', 'sleep 30 &']
    });

    await leaderExited;
    expect(isProcessGroupRunning(managed.pid)).toBe(true);
    await supervisor.close();
    expect(managed.snapshot().state).toBe('exited');
    expect(isProcessGroupRunning(managed.pid)).toBe(false);
  });

  test('public kill cleans redirected descendants after the leader exits', async () => {
    let leaderExitedResolve: () => void = () => {};
    const leaderExited = new Promise<void>((resolve) => {
      leaderExitedResolve = resolve;
    });
    setManagedProcessSupervisorTestHooks({ exitSettled: leaderExitedResolve });
    await using supervisor = new ManagedProcessSupervisor();
    const pidFile = descendantPidFile('public-kill');
    const managed = await supervisor.start({
      runId: 'leader-exit-public-kill',
      command: redirectedDescendantCommand(pidFile)
    });

    const descendantPid = await readPidFile(pidFile);
    await leaderExited;
    expect(managed.snapshot().state).toBe('running');
    expect(isProcessGroupRunning(managed.pid)).toBe(true);
    await managed.kill(9);
    expect(await managed.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    await expectProcessResourceGone(managed.pid, descendantPid);
    await Bun.file(pidFile).delete();
  });

  test('lifetime timeout cleans redirected descendants after leader exit', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const pidFile = descendantPidFile('timeout');
    const managed = await supervisor.start({
      runId: 'leader-exit-timeout',
      command: redirectedDescendantCommand(pidFile),
      timeoutMs: 100
    });
    const descendantPid = await readPidFile(pidFile);

    expect(await managed.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 0, timedOut: true }
    });
    await expectProcessResourceGone(managed.pid, descendantPid);
    await Bun.file(pidFile).delete();
  });

  test('supervisor close cleans redirected descendants after leader exit', async () => {
    let leaderExitedResolve: () => void = () => {};
    const leaderExited = new Promise<void>((resolve) => {
      leaderExitedResolve = resolve;
    });
    setManagedProcessSupervisorTestHooks({ exitSettled: leaderExitedResolve });
    const supervisor = new ManagedProcessSupervisor();
    const pidFile = descendantPidFile('close');
    const managed = await supervisor.start({
      runId: 'leader-exit-close',
      command: redirectedDescendantCommand(pidFile)
    });

    const descendantPid = await readPidFile(pidFile);
    await leaderExited;
    expect(managed.snapshot().state).toBe('running');
    expect(isProcessGroupRunning(managed.pid)).toBe(true);
    await supervisor.close();
    expect(managed.snapshot().state).toBe('exited');
    await expectProcessResourceGone(managed.pid, descendantPid);
    await Bun.file(pidFile).delete();
  });

  test('public kill never schedules escalation', async () => {
    const delivered: number[] = [];
    setManagedProcessSupervisorTestHooks({
      signal: async (pid, signal) => {
        delivered.push(signal);
        await signalProcessTree(pid, signal);
      }
    });
    const supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'no-public-escalation',
      command: [
        '/bin/bash',
        '-lc',
        "trap '' TERM; echo ready; while :; do sleep 1; done"
      ]
    });
    await waitForOutput(process, 'ready');

    await process.kill();
    await Bun.sleep(150);
    expect(process.snapshot().state).toBe('running');
    expect(delivered).toEqual([15]);

    setManagedProcessSupervisorTestHooks();
    await signalProcessTree(process.pid, 9);
    expect(await process.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 137, signal: 9, timedOut: false }
    });
    await supervisor.close();
  });

  test('timeout teardown escalates and reports the observed final signal', async () => {
    const delivered: number[] = [];
    setManagedProcessSupervisorTestHooks({
      signal: async (pid, signal) => {
        delivered.push(signal);
        await signalProcessTree(pid, signal);
      }
    });
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'timeout-escalation',
      command: [
        '/bin/bash',
        '-lc',
        "trap '' TERM; echo ready; while :; do sleep 1; done"
      ],
      timeoutMs: 100
    });
    await waitForOutput(process, 'ready');

    expect(await process.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 137, signal: 9, timedOut: true }
    });
    expect(delivered).toEqual([15, 9]);
  }, 3_000);

  test('failed public signal delivery keeps the process supervised', async () => {
    let signalFailure = true;
    setManagedProcessSupervisorTestHooks({
      signal: async (pid, signal) => {
        if (signalFailure) throw new Error('signal denied');
        await signalProcessTree(pid, signal);
      }
    });
    await using supervisor = new ManagedProcessSupervisor();
    const managed = await supervisor.start({
      runId: 'signal-failure',
      command: ['sleep', '30']
    });

    await expect(managed.kill()).rejects.toThrow('signal denied');
    expect(managed.snapshot().state).toBe('running');
    expect(supervisor.hasActive()).toBe(true);

    signalFailure = false;
    await managed.kill(9);
    expect(await managed.waitForExit()).toMatchObject({
      state: 'exited',
      exit: { code: 137, signal: 9, timedOut: false }
    });
  });

  test('observed exit conversion failures settle as structured errors', async () => {
    const observedSignal = spyOn(signalModule, 'observedSignalNumber');
    observedSignal.mockImplementation(() => {
      throw new Error('signal conversion denied');
    });
    const supervisor = new ManagedProcessSupervisor();
    const managed = await supervisor.start({
      runId: 'observed-exit-failure',
      command: ['true']
    });

    try {
      expect(await managed.waitForExit()).toMatchObject({
        state: 'error',
        error: { code: 'EXIT_FAILED', message: 'signal conversion denied' }
      });
    } finally {
      observedSignal.mockRestore();
      if (managed.snapshot().state !== 'running') await supervisor.close();
    }
  });

  test('process-group observation failures settle as structured errors', async () => {
    setManagedProcessSupervisorTestHooks({
      groupRunning: () => {
        throw new Error('group observation denied');
      }
    });
    await using supervisor = new ManagedProcessSupervisor();
    const managed = await supervisor.start({
      runId: 'group-observation-failure',
      command: ['sleep', '30']
    });

    expect(await managed.waitForExit()).toMatchObject({
      state: 'error',
      error: {
        code: 'PROCESS_GROUP_CHECK_FAILED',
        message: 'group observation denied'
      }
    });
  });

  test('drain failures settle as structured errors', async () => {
    setManagedProcessSupervisorTestHooks({
      drain: async () => {
        throw new Error('drain denied');
      }
    });
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'drain-failure',
      command: ['sleep', '30']
    });

    expect(await process.waitForExit()).toMatchObject({
      state: 'error',
      error: { code: 'DRAIN_FAILED', message: 'drain denied' }
    });
  });

  test('isolates stored argv from caller mutation', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    const command = ['printf', 'ok'];
    const process = await supervisor.start({
      runId: 'argv-copy',
      command: command as ['printf', string]
    });
    command[0] = 'mutated';
    command.push('later');
    expect(process.snapshot().command).toEqual(['printf', 'ok']);
    expect(await process.waitForExit()).toMatchObject({
      command: ['printf', 'ok'],
      state: 'exited'
    });
  });

  test('repeated waits and terminal controls are idempotent', async () => {
    let signals = 0;
    setManagedProcessSupervisorTestHooks({
      signal: async (pid, signal) => {
        signals++;
        await signalProcessTree(pid, signal);
      }
    });
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'idempotent',
      command: ['true']
    });
    const [first, second] = await Promise.all([
      process.waitForExit(),
      process.waitForExit()
    ]);
    await process.kill();
    await process.kill(9);
    expect(first).toEqual(second);
    expect(signals).toBe(0);
  });

  test('terminal-only removal refuses active processes', async () => {
    const supervisor = new ManagedProcessSupervisor();
    const active = await supervisor.start({
      runId: 'active',
      command: ['sleep', '30']
    });
    expect(supervisor.removeTerminal('active')).toBe(false);
    await signalProcessTree(active.pid, 9);
    await active.waitForExit();
    expect(supervisor.removeTerminal('active')).toBe(true);
    expect(supervisor.get('active')).toBeUndefined();
    await supervisor.close();
  });

  test('hasActive tracks only running processes', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    expect(supervisor.hasActive()).toBe(false);
    const process = await supervisor.start({
      runId: 'active',
      command: ['true']
    });
    expect(supervisor.hasActive()).toBe(true);
    await process.waitForExit();
    expect(supervisor.hasActive()).toBe(false);
    expect(supervisor.list()).toHaveLength(1);
  });

  test('emits terminal after output and calls callback once under competition', async () => {
    let callbacks = 0;
    await using supervisor = new ManagedProcessSupervisor();
    const process = await supervisor.start({
      runId: 'competition',
      command: ['bash', '-c', 'printf before; sleep 30'],
      onTerminal: async () => {
        callbacks++;
        throw new Error('callback failure');
      }
    });
    await waitForOutput(process, 'before');
    await process.kill(9);
    await process.waitForExit();
    expect(await collectEventKinds(process.logs({ replay: true }))).toEqual([
      'stdout',
      'terminal'
    ]);
    expect(callbacks).toBe(1);
  });

  test('rejects duplicate IDs and launches that cannot spawn', async () => {
    await using supervisor = new ManagedProcessSupervisor();
    await expect(
      supervisor.start({ runId: 'bad', command: ['/definitely/missing'] })
    ).rejects.toThrow();
    await supervisor.start({ runId: 'same', command: ['sleep', '.1'] });
    await expect(
      supervisor.start({ runId: 'same', command: ['true'] })
    ).rejects.toThrow();
  });
});

function descendantPidFile(testName: string): string {
  return `/tmp/sandbox-execution-${testName}-${crypto.randomUUID()}.pid`;
}

function redirectedDescendantCommand(
  pidFile: string
): [string, string, string] {
  return [
    '/bin/bash',
    '-lc',
    `sleep 30 >/dev/null 2>&1 & printf '%s' "$!" > '${pidFile}'`
  ];
}

async function readPidFile(path: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await Bun.file(path)
      .text()
      .catch(() => '');
    const pid = Number(text);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for descendant PID file: ${path}`);
}

async function expectProcessResourceGone(
  processGroupId: number,
  descendantPid: number,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      !isProcessGroupRunning(processGroupId) &&
      !isPidRunning(descendantPid)
    ) {
      return;
    }
    await Bun.sleep(10);
  }
  expect(isProcessGroupRunning(processGroupId)).toBe(false);
  expect(isPidRunning(descendantPid)).toBe(false);
}

async function waitForOutput(
  process: RuntimeManagedProcess,
  pattern: string | Uint8Array,
  timeoutMs = 2_000
): Promise<void> {
  const needle =
    typeof pattern === 'string' ? new TextEncoder().encode(pattern) : pattern;
  const reader = process.logs({ replay: true, follow: true }).getReader();
  const timeout = Bun.sleep(timeoutMs).then(() => {
    throw new Error(`Timed out waiting for process log after ${timeoutMs}ms`);
  });
  let tail = new Uint8Array();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) throw new Error('Process exited before log was found');
      const event = result.value;
      if (event.type !== 'stdout' && event.type !== 'stderr') continue;
      const combined = concatBytes(tail, event.data);
      if (containsBytes(combined, needle)) return;
      tail = combined.slice(
        Math.max(0, combined.byteLength - needle.byteLength + 1)
      );
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function collectEventKinds(
  stream: ReadableStream<{ type?: string; state?: string }>
): Promise<string[]> {
  const kinds: string[] = [];
  for await (const event of stream) kinds.push(event.type ?? event.state ?? '');
  return kinds;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (
    let start = 0;
    start <= haystack.byteLength - needle.byteLength;
    start++
  ) {
    for (let index = 0; index < needle.byteLength; index++) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}
