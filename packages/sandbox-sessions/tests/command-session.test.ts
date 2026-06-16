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

  it('preserves shell functions across commands', async () => {
    await using session = await CommandSession.create();

    const defineFunction = await session.exec(
      String.raw`say_func() { printf "func:%s\n" "$1"; }`
    );
    const useFunction = await session.exec('say_func ok');

    expect(defineFunction.exitCode).toBe(0);
    expect(useFunction.exitCode).toBe(0);
    expect(collect(useFunction.output, 'stdout')).toBe('func:ok\n');
  });

  it('preserves sourced shell state across commands', async () => {
    await using session = await CommandSession.create({ cwd: '/tmp' });

    const writeScript =
      await session.exec(String.raw`cat > sandbox-source-test.sh <<'EOF'
export SOURCED_VALUE=ok
sourced_func() { printf "sourced:%s\n" "$SOURCED_VALUE"; }
EOF`);
    const sourceScript = await session.exec('source ./sandbox-source-test.sh');
    const useSourcedState = await session.exec('sourced_func');

    expect(writeScript.exitCode).toBe(0);
    expect(sourceScript.exitCode).toBe(0);
    expect(useSourcedState.exitCode).toBe(0);
    expect(collect(useSourcedState.output, 'stdout')).toBe('sourced:ok\n');
  });

  it('queues concurrent exec calls in order', async () => {
    await using session = await CommandSession.create();

    const setState = session.exec(
      "sleep 1; export QUEUED_VALUE=ok; printf 'first\n'"
    );
    const readState = session.exec('printf "%s\n" "$QUEUED_VALUE"');

    const [setStateResult, readStateResult] = await Promise.all([
      setState,
      readState
    ]);

    expect(setStateResult.exitCode).toBe(0);
    expect(readStateResult.exitCode).toBe(0);
    expect(collect(setStateResult.output, 'stdout')).toBe('first\n');
    expect(collect(readStateResult.output, 'stdout')).toBe('ok\n');
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

  it('keeps the session usable when onOutput throws', async () => {
    await using session = await CommandSession.create();

    await expect(
      session.exec("printf 'before-error\n'", {
        onOutput: () => {
          throw new Error('consumer failed');
        }
      })
    ).rejects.toThrow('consumer failed');

    const nextResult = await session.exec("printf 'after-error\n'");

    expect(nextResult.exitCode).toBe(0);
    expect(collect(nextResult.output, 'stdout')).toBe('after-error\n');
  });

  it('cancels a running command and preserves shell state', async () => {
    const session = await CommandSession.create();
    let resultPromise: Promise<CommandSessionExecResult> | undefined;

    try {
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      await session.exec('export CANCEL_STATE=survived');

      resultPromise = session.exec(
        "printf 'started\n'; sleep 10; printf 'after-cancel\n'",
        {
          timeoutMs: 5_000,
          signal: controller.signal,
          onOutput: (chunk) => {
            if (chunk.stream === 'stdout' && chunk.data.includes('started')) {
              started.resolve();
            }
          }
        }
      );

      await Promise.race([
        started.promise,
        Bun.sleep(750).then(() => {
          throw new Error('Timed out waiting for command start');
        })
      ]);
      controller.abort();

      await expect(
        Promise.race([
          resultPromise,
          Bun.sleep(750).then(() => {
            throw new Error('Timed out waiting for cancellation');
          })
        ])
      ).rejects.toThrow('Command cancelled');

      const afterCancel = await session.exec('printf "%s\n" "$CANCEL_STATE"');
      expect(afterCancel.exitCode).toBe(0);
      expect(collect(afterCancel.output, 'stdout')).toBe('survived\n');
    } finally {
      resultPromise?.catch(() => {});
      await session.close();
    }
  });

  it('cancels a command before it emits output', async () => {
    const session = await CommandSession.create();
    let resultPromise: Promise<CommandSessionExecResult> | undefined;

    try {
      const controller = new AbortController();
      await session.exec('export EARLY_CANCEL_STATE=survived');

      resultPromise = session.exec("sleep 10; printf 'after-cancel\n'", {
        timeoutMs: 5_000,
        signal: controller.signal
      });
      await Bun.sleep(0);
      controller.abort();

      await expect(
        Promise.race([
          resultPromise,
          Bun.sleep(750).then(() => {
            throw new Error('Timed out waiting for cancellation');
          })
        ])
      ).rejects.toThrow('Command cancelled');

      const afterCancel = await session.exec(
        'printf "%s\n" "$EARLY_CANCEL_STATE"'
      );
      expect(afterCancel.exitCode).toBe(0);
      expect(collect(afterCancel.output, 'stdout')).toBe('survived\n');
    } finally {
      resultPromise?.catch(() => {});
      await session.close();
    }
  });

  it('does not cancel background jobs from earlier commands', async () => {
    const session = await CommandSession.create();
    let resultPromise: Promise<CommandSessionExecResult> | undefined;

    try {
      const background = await session.exec('sleep 10 & printf "%s\n" "$!"');
      const backgroundPID = collect(background.output, 'stdout').trim();
      const controller = new AbortController();

      resultPromise = session.exec('sleep 10', {
        timeoutMs: 5_000,
        signal: controller.signal
      });
      await Bun.sleep(0);
      controller.abort();

      await expect(
        Promise.race([
          resultPromise,
          Bun.sleep(750).then(() => {
            throw new Error('Timed out waiting for cancellation');
          })
        ])
      ).rejects.toThrow('Command cancelled');

      const backgroundStillRunning = await session.exec(
        `kill -0 ${backgroundPID}`
      );
      expect(backgroundStillRunning.exitCode).toBe(0);
    } finally {
      resultPromise?.catch(() => {});
      await session
        .exec('kill $(jobs -pr) 2>/dev/null || true')
        .catch(() => {});
      await session.close();
    }
  });

  it('marks the session failed after command timeout', async () => {
    const session = await CommandSession.create();

    try {
      await expect(session.exec('sleep 10', { timeoutMs: 50 })).rejects.toThrow(
        'Timed out waiting for command'
      );

      await expect(session.exec("printf 'after-timeout\n'")).rejects.toThrow(
        'Timed out waiting for command'
      );
    } finally {
      await session.close();
    }
  });

  it('marks the session failed when the shell exits', async () => {
    const session = await CommandSession.create();

    try {
      await expect(session.exec('exit')).rejects.toThrow(
        'Command session shell exited'
      );

      await expect(session.exec("printf 'after-exit\n'")).rejects.toThrow(
        'Command session shell exited'
      );
    } finally {
      await session.close();
    }
  });

  it('does not expose terminal APIs', async () => {
    await using session = await CommandSession.create();

    expect('attach' in session).toBe(false);
    expect('write' in session).toBe(false);
    expect('capture' in session).toBe(false);
  });
});
