import { describe, expect, it } from 'bun:test';
import { SequencedByteLog } from '../src/io/sequenced-byte-log';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

type TerminalValue = { code: number; details: { signal?: string } };

type Event =
  | { type: 'data'; cursor: string; timestamp: string; data: Uint8Array }
  | {
      type: 'terminal';
      cursor: string;
      timestamp: string;
      value: TerminalValue;
    }
  | { type: 'truncated'; cursor?: string; timestamp: string };

function copyTerminal(value: TerminalValue): TerminalValue {
  return { code: value.code, details: { ...value.details } };
}

async function readAll(stream: ReadableStream<Event>): Promise<Event[]> {
  const reader = stream.getReader();
  const events: Event[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return events;
    events.push(result.value);
  }
}

describe('SequencedByteLog', () => {
  it('replays arbitrary bytes with immutable copies', async () => {
    const log = new SequencedByteLog<'data', TerminalValue>({
      storeId: 'pty-1',
      maxBytes: 10,
      maxEvents: 10,
      copyTerminal
    });
    const input = bytes(0, 255, 128);
    const appended = log.append('data', input);
    input[0] = 1;
    appended.data[1] = 1;

    const events = await readAll(log.subscribe());
    expect(events[0]?.type).toBe('data');
    if (events[0]?.type !== 'data') throw new Error('Expected data');
    expect(events[0].data).toEqual(bytes(0, 255, 128));
  });

  it('supports replay, follow, cursors, and terminal close', async () => {
    const log = new SequencedByteLog<'data', TerminalValue>({
      storeId: 'pty-1',
      maxBytes: 10,
      maxEvents: 10,
      copyTerminal
    });
    const first = log.append('data', bytes(1));
    const reader = log
      .subscribe({ after: first.cursor, follow: true })
      .getReader();
    log.append('data', bytes(2));
    log.close({ code: 0, details: {} });

    expect((await reader.read()).value?.type).toBe('data');
    expect((await reader.read()).value?.type).toBe('terminal');
    expect((await reader.read()).done).toBe(true);
  });

  it('reports truncation and resumes at retained tail', async () => {
    const log = new SequencedByteLog<'data', TerminalValue>({
      storeId: 'pty-1',
      maxBytes: 1,
      maxEvents: 10,
      copyTerminal
    });
    const reader = log.subscribe({ replay: false, follow: true }).getReader();
    log.append('data', bytes(1, 2));
    log.append('data', bytes(3));

    expect((await reader.read()).value?.type).toBe('truncated');
    const retained = await reader.read();
    expect(retained.value?.type).toBe('data');
    if (retained.value?.type !== 'data') throw new Error('Expected data');
    expect(retained.value.data).toEqual(bytes(3));
    await reader.cancel();
  });

  it('copies terminal values for returns and subscribers', async () => {
    const log = new SequencedByteLog<'data', TerminalValue>({
      storeId: 'pty-copy',
      maxBytes: 10,
      maxEvents: 10,
      copyTerminal
    });
    const terminal = { code: 7, details: { signal: 'SIGTERM' } };
    const closed = log.close(terminal);
    closed.value.details.signal = 'SIGKILL';
    terminal.details.signal = 'SIGINT';

    const first = await readAll(log.subscribe());
    const second = await readAll(log.subscribe());
    expect(first[0]?.type).toBe('terminal');
    expect(second[0]?.type).toBe('terminal');
    if (first[0]?.type !== 'terminal' || second[0]?.type !== 'terminal') {
      throw new Error('Expected terminal');
    }
    first[0].value.details.signal = 'SIGHUP';
    expect(second[0].value.details.signal).toBe('SIGTERM');
  });

  it('retains high-volume tails without shifting replay order', async () => {
    const log = new SequencedByteLog<'data', TerminalValue>({
      storeId: 'pty-volume',
      maxBytes: 8192,
      maxEvents: 128,
      copyTerminal
    });
    for (let index = 0; index < 10_000; index++) {
      log.append('data', bytes(index % 256));
    }
    log.close({ code: 0, details: {} });

    const events = await readAll(log.subscribe());
    expect(events[0]?.type).toBe('truncated');
    const data = events.filter((event) => event.type === 'data');
    expect(data).toHaveLength(127);
    expect(events.at(-1)?.type).toBe('terminal');
    for (let index = 1; index < data.length; index++) {
      expect(data[index]?.data[0]).toBe((9873 + index) % 256);
    }
  });
});
