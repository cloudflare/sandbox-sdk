import { describe, expect, it } from 'bun:test';
import {
  CommandSession,
  type CommandSessionExecResult,
  type StdioChunk
} from '../src/index';

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

  it('preserves aliases across commands', async () => {
    await using session = await CommandSession.create();

    const defineAlias = await session.exec(
      String.raw`alias say_ok='printf "alias-ok\n"'`
    );
    const useAlias = await session.exec('say_ok');

    expect(defineAlias.exitCode).toBe(0);
    expect(useAlias.exitCode).toBe(0);
    expect(collect(useAlias.output, 'stdout')).toBe('alias-ok\n');
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

  it('streams output before the command completes', async () => {
    const session = await CommandSession.create();
    let resultPromise: Promise<CommandSessionExecResult> | undefined;

    try {
      const firstOutput = Promise.withResolvers<number>();
      const startedAt = performance.now();

      resultPromise = session.exec(
        "printf 'before-sleep\n'; sleep 2; printf 'after-sleep\n'",
        {
          timeoutMs: 5_000,
          onOutput: (chunk) => {
            if (
              chunk.stream === 'stdout' &&
              chunk.data.includes('before-sleep')
            ) {
              firstOutput.resolve(performance.now() - startedAt);
            }
          }
        }
      );

      const elapsedMs = await Promise.race([
        firstOutput.promise,
        Bun.sleep(750).then(() => {
          throw new Error('Timed out waiting for live output');
        })
      ]);
      const stateAfterFirstOutput = await Promise.race([
        resultPromise.then(() => 'settled'),
        Bun.sleep(100).then(() => 'pending')
      ]);
      const result = await resultPromise;

      expect(elapsedMs).toBeLessThan(750);
      expect(stateAfterFirstOutput).toBe('pending');
      expect(result.exitCode).toBe(0);
      expect(collect(result.output, 'stdout')).toBe(
        'before-sleep\nafter-sleep\n'
      );
    } finally {
      resultPromise?.catch(() => {});
      await session.close();
    }
  });

  it('does not wait for background children that inherit stdout', async () => {
    const session = await CommandSession.create();
    let resultPromise: Promise<CommandSessionExecResult> | undefined;

    try {
      resultPromise = session.exec("sleep 2 & printf 'done\n'", {
        timeoutMs: 5_000
      });

      const result = await Promise.race([
        resultPromise,
        Bun.sleep(750).then(() => {
          throw new Error('Foreground command waited for background stdout');
        })
      ]);

      expect(result.exitCode).toBe(0);
      expect(collect(result.output, 'stdout')).toBe('done\n');
    } finally {
      resultPromise?.catch(() => {});
      await session.close();
    }
  });

  it('captures output without a trailing newline', async () => {
    await using session = await CommandSession.create();

    const result = await session.exec("printf 'no-newline'");

    expect(result.exitCode).toBe(0);
    expect(collect(result.output, 'stdout')).toBe('no-newline');
  });

  it('streams short output before a trailing newline arrives', async () => {
    const session = await CommandSession.create();
    let resultPromise: Promise<CommandSessionExecResult> | undefined;

    try {
      const firstOutput = Promise.withResolvers<string>();

      resultPromise = session.exec(
        "printf 'prompt: '; sleep 2; printf 'done\n'",
        {
          timeoutMs: 5_000,
          onOutput: (chunk) => {
            if (chunk.stream === 'stdout' && chunk.data.includes('prompt: ')) {
              firstOutput.resolve(chunk.data);
            }
          }
        }
      );

      const firstChunk = await Promise.race([
        firstOutput.promise,
        Bun.sleep(750).then(() => {
          throw new Error('Timed out waiting for partial output');
        })
      ]);
      const stateAfterFirstOutput = await Promise.race([
        resultPromise.then(() => 'settled'),
        Bun.sleep(100).then(() => 'pending')
      ]);
      const result = await resultPromise;

      expect(firstChunk).toContain('prompt: ');
      expect(stateAfterFirstOutput).toBe('pending');
      expect(result.exitCode).toBe(0);
      expect(collect(result.output, 'stdout')).toBe('prompt: done\n');
    } finally {
      resultPromise?.catch(() => {});
      await session.close();
    }
  });

  it('keeps command stdin separate from the session protocol', async () => {
    await using session = await CommandSession.create();

    const readResult = await session.exec('read value');
    const nextResult = await session.exec("printf 'still-alive\n'");

    expect(readResult.exitCode).not.toBe(0);
    expect(collect(readResult.output, 'stdout')).toBe('');
    expect(nextResult.exitCode).toBe(0);
    expect(collect(nextResult.output, 'stdout')).toBe('still-alive\n');
  });

  it('does not expose terminal APIs', async () => {
    await using session = await CommandSession.create();

    expect('attach' in session).toBe(false);
    expect('write' in session).toBe(false);
    expect('capture' in session).toBe(false);
  });
});
