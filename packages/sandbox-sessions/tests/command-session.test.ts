import { describe, expect, it } from 'bun:test';
import { CommandSession, type StdioChunk } from '../src/index';

function collect(output: StdioChunk[], stream: StdioChunk['stream']): string {
  return output
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join('');
}

describe('CommandSession', () => {
  it('preserves shell state and returns structured output chunks', async () => {
    await using session = await CommandSession.create({ cwd: '/tmp' });

    const first = await session.exec(
      'mkdir -p sandbox-sessions-test && cd sandbox-sessions-test && pwd'
    );
    const second = await session.exec(
      "printf 'out\\n'; printf 'err\\n' >&2; pwd"
    );

    expect(first.exitCode).toBe(0);
    expect(collect(first.output, 'stdout')).toContain(
      '/tmp/sandbox-sessions-test'
    );
    expect(second.exitCode).toBe(0);
    expect(collect(second.output, 'stdout')).toContain('out\n');
    expect(collect(second.output, 'stdout')).toContain(
      '/tmp/sandbox-sessions-test'
    );
    expect(collect(second.output, 'stderr')).toBe('err\n');
    expect(second.output.map((chunk) => chunk.seq)).toEqual(
      second.output.map((_, index) => index)
    );
  });

  it('streams the same output chunks returned in the final result', async () => {
    await using session = await CommandSession.create();
    const streamed: StdioChunk[] = [];

    const result = await session.exec("printf 'a\\n'; printf 'b\\n' >&2", {
      onOutput: (chunk) => streamed.push(chunk)
    });

    expect(result.exitCode).toBe(0);
    expect(streamed).toEqual(result.output);
    expect(collect(result.output, 'stdout')).toBe('a\n');
    expect(collect(result.output, 'stderr')).toBe('b\n');
  });

  it('does not expose terminal APIs', async () => {
    await using session = await CommandSession.create();

    expect('attach' in session).toBe(false);
    expect('write' in session).toBe(false);
    expect('capture' in session).toBe(false);
  });
});
