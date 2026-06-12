import { describe, expect, it } from 'bun:test';
import { TerminalSession } from '../src/index';

describe('TerminalSession shell protocol', () => {
  it('runs prompt-bound commands with clean terminal transcript and persistent shell state', async () => {
    await using session = await TerminalSession.create();

    const first = await session.exec('echo hi');
    const second = await session.exec('cd /tmp && pwd');
    const third = await session.exec('pwd');

    expect(first.exitCode).toBe(0);
    expect(first.transcript).toContain('echo hi');
    expect(first.transcript).toContain('hi');
    expect(first.transcript).not.toContain('EXEC_DONE');
    expect(first.transcript).not.toContain('TERMINAL_SESSION');

    expect(second.exitCode).toBe(0);
    expect(second.transcript).toContain('/tmp');
    expect(third.exitCode).toBe(0);
    expect(third.transcript).toContain('/tmp');
  });
});
