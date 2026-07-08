import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  ProcessLogStore,
  type TerminalLogDetails
} from '../src/process/process-log-store';
import type { RuntimeProcessLogEvent } from '../src/process/types';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

async function readAll(
  stream: ReadableStream<RuntimeProcessLogEvent>
): Promise<RuntimeProcessLogEvent[]> {
  const reader = stream.getReader();
  const events: RuntimeProcessLogEvent[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return events;
    events.push(result.value);
  }
}

describe('ProcessLogStore', () => {
  it('preserves arbitrary bytes and returns immutable copies', async () => {
    const store = new ProcessLogStore('run-1');
    const input = bytes(0, 255, 128);
    const appended = store.appendOutput(
      'stdout',
      input,
      '2026-01-01T00:00:00.000Z'
    );
    input[0] = 42;
    appended.data[1] = 42;

    const first = await readAll(store.subscribe());
    expect(first[0]?.type).toBe('stdout');
    if (first[0]?.type !== 'stdout') throw new Error('Expected stdout');
    expect(first[0].data).toEqual(bytes(0, 255, 128));
    first[0].data[0] = 99;

    const second = await readAll(store.subscribe());
    if (second[0]?.type !== 'stdout') throw new Error('Expected stdout');
    expect(second[0].data).toEqual(bytes(0, 255, 128));
  });

  it('replays strictly after a cursor and defaults to replay only', async () => {
    const store = new ProcessLogStore('run-1');
    const first = store.appendOutput('stdout', bytes(1));
    store.appendOutput('stderr', bytes(2));
    const events = await readAll(store.subscribe({ after: first.cursor }));
    expect(events.map((event) => event.type)).toEqual(['stderr']);
  });

  it('supports future-only follow', async () => {
    const store = new ProcessLogStore('run-1');
    store.appendOutput('stdout', bytes(1));
    const reader = store.subscribe({ replay: false, follow: true }).getReader();
    store.appendOutput('stderr', bytes(2));
    const result = await reader.read();
    expect(result.value?.type).toBe('stderr');
    await reader.cancel();
  });

  it('registers replay-plus-follow without gaps or duplicates', async () => {
    const store = new ProcessLogStore('run-1');
    store.appendOutput('stdout', bytes(1));
    const reader = store.subscribe({ follow: true }).getReader();
    store.appendOutput('stdout', bytes(2));
    const first = await reader.read();
    const second = await reader.read();
    expect([first.value?.type, second.value?.type]).toEqual([
      'stdout',
      'stdout'
    ]);
    if (first.value?.type !== 'stdout' || second.value?.type !== 'stdout') {
      throw new Error('Expected stdout');
    }
    expect([first.value.data[0], second.value.data[0]]).toEqual([1, 2]);
    await reader.cancel();
  });

  it('stops delivery to cancelled subscribers', async () => {
    const store = new ProcessLogStore('run-1');
    const reader = store.subscribe({ replay: false, follow: true }).getReader();
    await reader.cancel();
    expect(() => store.appendOutput('stdout', bytes(1))).not.toThrow();
    expect((await reader.read()).done).toBe(true);
  });

  it('closes subscriptions after a terminal event', async () => {
    const store = new ProcessLogStore('run-1');
    const reader = store.subscribe({ replay: false, follow: true }).getReader();
    store.appendTerminal({
      state: 'exited',
      exit: { code: 0, timedOut: false }
    });
    expect((await reader.read()).value?.state).toBe('exited');
    expect((await reader.read()).done).toBe(true);
    expect(() => store.appendOutput('stdout', bytes(1))).toThrow();
  });

  it('isolates terminal exit objects across append and replay', async () => {
    const store = new ProcessLogStore('run-1');
    const details: TerminalLogDetails = {
      state: 'exited',
      exit: { code: 0, signal: 15, timedOut: false }
    };
    const appended = store.appendTerminal(details);
    if (appended.state !== 'exited') throw new Error('Expected exit');
    details.exit.code = 42;
    appended.exit.signal = 9;

    const first = await readAll(store.subscribe());
    expect(first[0]?.state).toBe('exited');
    if (first[0]?.state !== 'exited') {
      throw new Error('Expected terminal exit');
    }
    expect(first[0].exit).toEqual({
      code: 0,
      signal: 15,
      timedOut: false
    });
    first[0].exit.timedOut = true;

    const second = await readAll(store.subscribe());
    expect(second[0]?.state).toBe('exited');
    if (second[0]?.state !== 'exited') throw new Error('Expected terminal');
    expect(second[0].exit).toEqual({
      code: 0,
      signal: 15,
      timedOut: false
    });
  });

  it('rejects stale, malformed, noncanonical, and future cursors', () => {
    const first = new ProcessLogStore('run-1');
    const cursor = first.appendOutput('stdout', bytes(1)).cursor;
    const second = new ProcessLogStore('run-2');
    expect(() => second.subscribe({ after: cursor })).toThrow(/run/);
    expect(() => first.subscribe({ after: 'not+a+cursor' })).toThrow(/Invalid/);
    expect(() => first.subscribe({ after: `${cursor}=` })).toThrow(/Invalid/);

    const runId = Buffer.from('run-1').toString('base64url');
    const noncanonical = Buffer.from(`v1.${runId}.01`).toString('base64url');
    const future = Buffer.from(`v1.${runId}.2`).toString('base64url');
    expect(() => first.subscribe({ after: noncanonical })).toThrow(/Invalid/);
    expect(() => first.subscribe({ after: future })).toThrow(/future/);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('.');
  });

  it('emits truncation for an expired cursor', async () => {
    const store = new ProcessLogStore('run-1', { maxBytes: 2, maxEvents: 10 });
    const cursor = store.appendOutput('stdout', bytes(1, 2)).cursor;
    store.appendOutput('stdout', bytes(3, 4));
    store.appendOutput('stdout', bytes(5, 6));
    const events = await readAll(store.subscribe({ after: cursor }));
    expect(events.map((event) => event.type)).toEqual(['truncated', 'stdout']);
  });

  it('evicts whole events to enforce the byte bound', async () => {
    const store = new ProcessLogStore('run-1', { maxBytes: 3, maxEvents: 10 });
    store.appendOutput('stdout', bytes(1, 2));
    store.appendOutput('stderr', bytes(3, 4));
    const events = await readAll(store.subscribe());
    expect(events.map((event) => event.type)).toEqual(['truncated', 'stderr']);
  });

  it('reports an oversized single event as truncated during replay', async () => {
    const store = new ProcessLogStore('run-1', { maxBytes: 1, maxEvents: 10 });
    store.appendOutput('stdout', bytes(1, 2));

    const events = await readAll(store.subscribe());
    expect(events.map((event) => event.type)).toEqual(['truncated']);
  });

  it('resumes a non-reading follower after an oversized single event', async () => {
    const store = new ProcessLogStore('run-1', { maxBytes: 1, maxEvents: 10 });
    const reader = store.subscribe({ replay: false, follow: true }).getReader();
    store.appendOutput('stdout', bytes(1, 2));
    store.appendOutput('stderr', bytes(3));

    expect((await reader.read()).value?.type).toBe('truncated');
    const retained = (await reader.read()).value;
    expect(retained?.type).toBe('stderr');
    if (retained?.type !== 'stderr') throw new Error('Expected stderr');
    expect(retained.data).toEqual(bytes(3));
    await reader.cancel();
  });

  it('bounds a non-reading follower and resumes it at the retained tail', async () => {
    const store = new ProcessLogStore('run-1', { maxBytes: 10, maxEvents: 1 });
    const reader = store.subscribe({ replay: false, follow: true }).getReader();
    store.appendOutput('stdout', bytes(1));
    store.appendOutput('stdout', bytes(2));
    store.appendOutput('stderr', bytes(3));

    const queued = await reader.read();
    const truncated = await reader.read();
    const tail = await reader.read();
    if (queued.value?.type !== 'stdout' || tail.value?.type !== 'stderr') {
      throw new Error('Expected retained output events');
    }
    expect(queued.value.data).toEqual(bytes(1));
    expect(truncated.value?.type).toBe('truncated');
    expect(tail.value.data).toEqual(bytes(3));
    await reader.cancel();
  });

  it('isolates bytes between live subscribers', async () => {
    const store = new ProcessLogStore('run-1');
    const first = store.subscribe({ replay: false, follow: true }).getReader();
    const second = store.subscribe({ replay: false, follow: true }).getReader();
    store.appendOutput('stdout', bytes(4, 5));
    const firstEvent = (await first.read()).value;
    const secondEvent = (await second.read()).value;
    if (firstEvent?.type !== 'stdout' || secondEvent?.type !== 'stdout') {
      throw new Error('Expected stdout');
    }
    firstEvent.data[0] = 9;
    expect(secondEvent.data).toEqual(bytes(4, 5));
    await first.cancel();
    await second.cancel();
  });

  it('does not allow terminal extras to replace owned fields', async () => {
    const store = new ProcessLogStore('run-1');
    const details: TerminalLogDetails & {
      type: 'stdout';
      cursor: string;
      timestamp: string;
    } = {
      state: 'exited',
      type: 'stdout',
      cursor: 'forged',
      timestamp: 'forged',
      exit: { code: 0, timedOut: false }
    };
    const terminal = store.appendTerminal(details, '2026-01-01T00:00:00.000Z');
    expect(terminal.state).toBe('exited');
    expect(terminal.type).toBe('terminal');
    expect(terminal.cursor).not.toBe('forged');
    expect(terminal.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect((await readAll(store.subscribe()))[0]).toEqual(terminal);
  });

  it('replays the retained event limit without array rescanning', async () => {
    const eventCount = 10_000;
    const store = new ProcessLogStore('run-1', {
      maxBytes: eventCount,
      maxEvents: eventCount
    });
    for (let value = 0; value < eventCount; value++) {
      store.appendOutput('stdout', bytes(value % 256));
    }

    const originalFind = Array.prototype.find;
    Array.prototype.find = () => {
      throw new Error('Sequential replay must not scan the retained array');
    };
    let events: RuntimeProcessLogEvent[];
    try {
      events = await readAll(store.subscribe());
    } finally {
      Array.prototype.find = originalFind;
    }

    expect(events).toHaveLength(eventCount);
    expect(events[0]?.type).toBe('stdout');
    expect(events[eventCount - 1]?.type).toBe('stdout');
  });

  it('enforces the event bound', async () => {
    const store = new ProcessLogStore('run-1', { maxBytes: 10, maxEvents: 1 });
    store.appendOutput('stdout', bytes(1));
    store.appendOutput('stderr', bytes(2));
    const events = await readAll(store.subscribe());
    expect(events.map((event) => event.type)).toEqual(['truncated', 'stderr']);
  });
});
