import { describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { signalProcessTree } from '../src/process/process-tree';
import { PtyCompletionBarrier, PtyProcess } from '../src/pty/pty-process';
import type { RuntimeTerminalOutputEvent } from '../src/pty/types';

const decoder = new TextDecoder();
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

async function collectUntil(
  pty: PtyProcess,
  predicate: (events: RuntimeTerminalOutputEvent[]) => boolean,
  timeoutMs = 5000
): Promise<RuntimeTerminalOutputEvent[]> {
  const reader = pty.output({ follow: true }).getReader();
  const events: RuntimeTerminalOutputEvent[] = [];
  const timeout = Bun.sleep(timeoutMs).then(() => {
    throw new Error('Timed out waiting for PTY output');
  });
  try {
    await Promise.race([
      (async () => {
        while (!predicate(events)) {
          const result = await reader.read();
          if (result.done) break;
          events.push(result.value);
        }
      })(),
      timeout
    ]);
    return events;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function waitForMarker(path: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const text = await Bun.file(path).text();
      const trimmed = text.trim();
      if (trimmed.length > 0) return Number(trimmed);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Timed out waiting for marker ${path}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`
  );
}

async function isPidRunning(pid: number): Promise<boolean> {
  const process = Bun.spawn(['ps', '-o', 'stat=', '-p', String(pid)], {
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const text = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) return false;
  return !text.trim().startsWith('Z');
}

function text(events: RuntimeTerminalOutputEvent[]): string {
  const chunks = events
    .filter((event) => event.type === 'data')
    .map((event) => event.data);
  return decoder.decode(Buffer.concat(chunks));
}

describe('PtyCompletionBarrier', () => {
  test('finishes when subprocess exit is followed by PTY EOF', () => {
    const exits: unknown[] = [];
    const barrier = new PtyCompletionBarrier((exit) => exits.push(exit));

    barrier.subprocessExited(7, null);
    expect(exits).toHaveLength(0);

    barrier.terminalEOF();
    expect(exits).toEqual([
      { state: 'exited', exit: { code: 7, timedOut: false } }
    ]);
  });

  test('finishes when PTY EOF is followed by subprocess exit', () => {
    const exits: unknown[] = [];
    const barrier = new PtyCompletionBarrier((exit) => exits.push(exit));

    barrier.terminalEOF();
    expect(exits).toHaveLength(0);

    barrier.subprocessExited(0, null);
    expect(exits).toEqual([
      { state: 'exited', exit: { code: 0, timedOut: false } }
    ]);
  });

  test('allows final data before EOF and closes only once', () => {
    const events: string[] = [];
    const barrier = new PtyCompletionBarrier((result) => {
      events.push(
        `terminal:${result.state === 'exited' ? result.exit.code : result.error.code}`
      );
    });

    barrier.subprocessExited(0, null);
    events.push('data:final');
    barrier.terminalEOF();
    events.push('data:late');
    barrier.terminalEOF();
    barrier.subprocessExited(1, null);

    expect(events).toEqual(['data:final', 'terminal:0', 'data:late']);
  });

  test('finishes with a structured error when subprocess exit wait rejects', () => {
    const results: unknown[] = [];
    const barrier = new PtyCompletionBarrier((result) => results.push(result));

    barrier.subprocessExitFailed(new Error('exit wait failed'));
    expect(results).toHaveLength(0);

    barrier.terminalEOF();
    expect(results).toEqual([
      {
        state: 'error',
        error: { code: 'PTY_EXIT_FAILED', message: 'exit wait failed' }
      }
    ]);
  });
});

describe('PtyProcess', () => {
  test('spawns exact argv without an implicit shell', async () => {
    const pty = await PtyProcess.create({
      command: [
        '/bin/bash',
        '-lc',
        'printf "%s:%s:%s" "$1" "$2" "$3"',
        'argv0',
        '$SHELL_LITERAL',
        '',
        'tail'
      ]
    });
    expect(await pty.waitForExit()).toEqual({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    const reader = pty.output().getReader();
    const events: RuntimeTerminalOutputEvent[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      events.push(result.value);
    }

    expect(text(events)).toContain('$SHELL_LITERAL::tail');
    await pty.close();
  });

  test('rejects empty argv and empty argv[0]', async () => {
    await expect(
      // @ts-expect-error Runtime validation rejects empty argv from untyped callers.
      PtyProcess.create({ command: [] })
    ).rejects.toThrow('Command must not be empty');
    await expect(PtyProcess.create({ command: [''] })).rejects.toThrow(
      'Command executable must not be empty'
    );
  });

  test('supports explicit shell argv, cwd, and environment overlay', async () => {
    const pty = await PtyProcess.create({
      command: ['/bin/bash', '-lc', 'printf "%s:%s" "$PWD" "$PTY_ENV"'],
      cwd: '/tmp',
      env: { PTY_ENV: 'present' }
    });
    const events = await collectUntil(pty, (items) =>
      items.some((event) => event.type === 'terminal')
    );

    expect(text(events)).toContain('/tmp:present');
    await pty.close();
  });

  test('preserves invalid output bytes and arbitrary input bytes', async () => {
    const output = await PtyProcess.create({
      command: ['/bin/bash', '-lc', 'printf "\\377A"']
    });
    const outputEvents = await collectUntil(output, (items) =>
      items.some((event) => event.type === 'terminal')
    );
    const data = Buffer.concat(
      outputEvents
        .filter((event) => event.type === 'data')
        .map((event) => event.data)
    );
    expect(data.includes(255)).toBe(true);
    await output.close();

    const input = await PtyProcess.create({ command: ['/bin/cat'] });
    const reader = input.output({ replay: false, follow: true }).getReader();
    await input.write(bytes(0xff, 0x41, 0x0d));
    let sawA = false;
    for (let attempt = 0; attempt < 10 && !sawA; attempt++) {
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(500).then(() => undefined)
      ]);
      if (result && !result.done && result.value.type === 'data') {
        sawA = result.value.data.includes(0x41);
      }
    }
    expect(sawA).toBe(true);
    await reader.cancel();
    await input.close();
  });

  test('validates resize and rejects writes after close', async () => {
    const pty = await PtyProcess.create({ command: ['/bin/cat'] });
    expect(() => pty.resize(100, 40)).not.toThrow();
    expect(() => pty.resize(0, 24)).toThrow('Invalid dimensions');
    await pty.close();
    await expect(pty.write(bytes(1))).rejects.toThrow('PTY is closed');
    expect(() => pty.resize(80, 24)).toThrow('PTY is closed');
  });

  test('reports observed numeric exit metadata for PTY settlements', async () => {
    const natural = await PtyProcess.create({
      command: ['/bin/bash', '-lc', 'exit 0']
    });
    expect(await natural.waitForExit()).toEqual({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    expect(natural.snapshot().state).toBe('exited');
    await natural.close();

    const nonzero = await PtyProcess.create({
      command: ['/bin/bash', '-lc', 'exit 42']
    });
    expect(await nonzero.waitForExit()).toEqual({
      state: 'exited',
      exit: { code: 42, timedOut: false }
    });
    expect(nonzero.snapshot().state).toBe('exited');
    await nonzero.close();
    await nonzero.close();

    const terminated = await PtyProcess.create({
      command: ['/bin/sleep', '30']
    });
    await terminated.terminate();
    expect(await terminated.waitForExit()).toEqual({
      state: 'exited',
      exit: { code: 143, signal: 15, timedOut: false }
    });
    expect(terminated.snapshot().state).toBe('exited');

    const killed = await PtyProcess.create({ command: ['/bin/sleep', '30'] });
    await signalProcessTree(killed.snapshot().pid, 9);
    expect(await killed.waitForExit()).toEqual({
      state: 'exited',
      exit: { code: 137, signal: 9, timedOut: false }
    });

    const handledTerm = await PtyProcess.create({
      command: [
        '/bin/bash',
        '-lc',
        "trap 'exit 0' TERM; echo ready; while :; do sleep 1; done"
      ]
    });
    await collectUntil(handledTerm, (events) => text(events).includes('ready'));
    await handledTerm.terminate();
    const handled = await handledTerm.waitForExit();
    expect(handled).toEqual({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    if (handled.state !== 'exited') throw new Error('Expected exit');
    expect(handled.exit.signal).toBeUndefined();
  });

  test('completes no-child PTY output only after EOF', async () => {
    const pty = await PtyProcess.create({
      command: ['/bin/bash', '-lc', 'printf immediate; exit 0']
    });
    const all = await collectUntil(pty, (items) =>
      items.some((event) => event.type === 'terminal')
    );
    expect(text(all)).toContain('immediate');
    expect(all.at(-1)?.type).toBe('terminal');
    expect(await pty.waitForExit()).toEqual({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    await pty.close();
  });

  test('orders trap output before exactly one terminal event', async () => {
    const pty = await PtyProcess.create({
      command: ['/bin/bash', '-lc', 'trap "printf final" EXIT; printf body']
    });
    const all = await collectUntil(pty, (items) =>
      items.some((event) => event.type === 'terminal')
    );
    expect(all.at(-1)?.type).toBe('terminal');
    expect(all.filter((event) => event.type === 'terminal')).toHaveLength(1);
    expect(text(all)).toContain('bodyfinal');
    const firstData = all.find((event) => event.type === 'data');
    if (firstData?.type !== 'data') throw new Error('Expected data');

    const replay = pty.output({ after: firstData.cursor }).getReader();
    const replayed: RuntimeTerminalOutputEvent[] = [];
    while (true) {
      const result = await replay.read();
      if (result.done) break;
      replayed.push(result.value);
    }
    expect(replayed[0]?.cursor).not.toBe(firstData.cursor);
    expect(replayed.at(-1)?.type).toBe('terminal');
    await pty.close();
  });

  test('terminates ignored SIGTERM process trees and is idempotent', async () => {
    const marker = `/tmp/pty-child-${crypto.randomUUID()}`;
    const pty = await PtyProcess.create({
      command: [
        '/bin/bash',
        '-lc',
        `trap '' TERM; /bin/sh -c 'trap "" TERM; echo $$ > ${marker}; while :; do sleep 1; done' & wait`
      ]
    });
    try {
      const childPid = await waitForMarker(marker);
      await pty.terminate();
      await pty.terminate();
      await pty.close();
      await pty.interrupt();
      expect(pty.snapshot().state).toBe('exited');
      expect(await isPidRunning(childPid)).toBe(false);
    } finally {
      await unlink(marker).catch(() => {});
    }
  });

  test('close kills ignored SIGTERM process trees before terminal close', async () => {
    const marker = `/tmp/pty-close-child-${crypto.randomUUID()}`;
    const pty = await PtyProcess.create({
      command: [
        '/bin/bash',
        '-lc',
        `trap '' TERM; /bin/sh -c 'trap "" TERM; echo $$ > ${marker}; while :; do sleep 1; done' & wait`
      ]
    });
    try {
      const childPid = await waitForMarker(marker);
      const start = Date.now();
      await pty.close();
      const exit = await pty.waitForExit();
      expect(Date.now() - start).toBeLessThan(3000);
      expect(exit.state).toBe('exited');
      if (exit.state !== 'exited') throw new Error('Expected exit');
      expect(exit.exit.code).not.toBe(0);
      expect(pty.snapshot().state).toBe('exited');
      expect(await isPidRunning(childPid)).toBe(false);
    } finally {
      await unlink(marker).catch(() => {});
    }
  });

  test('close kills ignored SIGTERM descendants after root exits', async () => {
    const marker = `/tmp/pty-close-descendant-${crypto.randomUUID()}`;
    const pty = await PtyProcess.create({
      command: [
        '/bin/bash',
        '-lc',
        `trap 'exit 0' TERM; /bin/sh -c 'trap "" TERM; echo $$ > ${marker}; while :; do sleep 1; done' & wait`
      ]
    });
    try {
      const childPid = await waitForMarker(marker);
      const start = Date.now();
      await pty.close();
      expect(Date.now() - start).toBeLessThan(3000);
      expect(pty.snapshot().state).toBe('exited');
      expect(await isPidRunning(childPid)).toBe(false);
    } finally {
      await unlink(marker).catch(() => {});
    }
  });

  test('reports truncation on replay and reconnects during output', async () => {
    const pty = await PtyProcess.create({
      command: [
        '/bin/bash',
        '-lc',
        'for i in 1 2 3 4; do printf $i; sleep 0.1; done'
      ],
      bufferSize: 2
    });
    const reader = pty.output({ follow: true }).getReader();
    const first = await reader.read();
    expect(first.value?.type).toBe('data');
    await reader.cancel();

    const tail = await collectUntil(pty, (items) =>
      items.some((event) => event.type === 'terminal')
    );
    expect(tail.some((event) => event.type === 'terminal')).toBe(true);

    const replay = pty.output().getReader();
    expect((await replay.read()).value?.type).toBe('truncated');
    await replay.cancel();
    await pty.close();
  });
});
