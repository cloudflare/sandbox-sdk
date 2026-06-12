import { describe, expect, it } from 'bun:test';
import { parseTerminalChunk } from '../src/protocol';

const nonce = 'nonce123';
const doneMarker = `\x1b]777;terminal-session|${nonce}|EXEC_DONE|exec1|0\x07`;

describe('terminal protocol parser', () => {
  it('preserves text and frame ordering within one terminal chunk', () => {
    const parsed = parseTerminalChunk({
      buffered: '',
      chunk: `before${doneMarker}after`,
      nonce
    });

    expect(parsed.buffered).toBe('');
    expect(parsed.events).toEqual([
      { kind: 'text', value: 'before' },
      {
        kind: 'frame',
        frame: { type: 'EXEC_DONE', id: 'exec1', payload: '0' }
      },
      { kind: 'text', value: 'after' }
    ]);
  });

  it('treats unterminated marker-like output as visible text after a newline', () => {
    const parsed = parseTerminalChunk({
      buffered: '',
      chunk: '\x1b]777;terminal-session|not-a-frame\nvisible',
      nonce
    });

    expect(parsed.buffered).toBe('');
    expect(parsed.events).toEqual([
      {
        kind: 'text',
        value: '\x1b]777;terminal-session|not-a-frame\nvisible'
      }
    ]);
  });
});
