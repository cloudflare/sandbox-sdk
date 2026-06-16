import { describe, expect, it } from 'bun:test';
import { CommandSession } from '../src/index';

describe('CommandSession', () => {
  it('preserves shell state and returns final stdout and stderr', async () => {
    await using session = await CommandSession.create({ cwd: '/tmp' });

    const first = await session.exec(
      'mkdir -p sandbox-sessions-test && cd sandbox-sessions-test && pwd'
    );
    const second = await session.exec(
      "printf 'out\n'; printf 'err\n' >&2; pwd"
    );

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('/tmp/sandbox-sessions-test');
    expect(first.stderr).toBe('');
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('out\n');
    expect(second.stdout).toContain('/tmp/sandbox-sessions-test');
    expect(second.stderr).toBe('err\n');
  });

  it('preserves aliases across commands', async () => {
    await using session = await CommandSession.create();

    const defineAlias = await session.exec(
      String.raw`alias say_ok='printf "alias-ok\n"'`
    );
    const useAlias = await session.exec('say_ok');

    expect(defineAlias.exitCode).toBe(0);
    expect(useAlias.exitCode).toBe(0);
    expect(useAlias.stdout).toBe('alias-ok\n');
  });

  it('preserves shell functions across commands', async () => {
    await using session = await CommandSession.create();

    const defineFunction = await session.exec(
      String.raw`say_func() { printf "func:%s\n" "$1"; }`
    );
    const useFunction = await session.exec('say_func ok');

    expect(defineFunction.exitCode).toBe(0);
    expect(useFunction.exitCode).toBe(0);
    expect(useFunction.stdout).toBe('func:ok\n');
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
    expect(useSourcedState.stdout).toBe('sourced:ok\n');
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
    expect(setStateResult.stdout).toBe('first\n');
    expect(readStateResult.stdout).toBe('ok\n');
  });

  it('resolves only after command completion', async () => {
    await using session = await CommandSession.create();
    const startedAt = performance.now();

    const result = await session.exec(
      "printf 'before-sleep\n'; sleep 1; printf 'after-sleep\n'",
      { timeoutMs: 5_000 }
    );

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('before-sleep\nafter-sleep\n');
    expect(result.stderr).toBe('');
  });

  it('does not wait for background children that inherit stdout', async () => {
    const session = await CommandSession.create();
    let resultPromise:
      | Promise<{ exitCode: number; stdout: string }>
      | undefined;

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
      expect(result.stdout).toBe('done\n');
    } finally {
      resultPromise?.catch(() => {});
      await session.close();
    }
  });

  it('captures output without a trailing newline', async () => {
    await using session = await CommandSession.create();

    const result = await session.exec("printf 'no-newline'");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('no-newline');
  });

  it('captures partial output after command completion', async () => {
    await using session = await CommandSession.create();

    const result = await session.exec(
      "printf 'prompt: '; sleep 1; printf 'done\n'",
      {
        timeoutMs: 5_000
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('prompt: done\n');
  });

  it('keeps command stdin separate from the session protocol', async () => {
    await using session = await CommandSession.create();

    const readResult = await session.exec('read value');
    const nextResult = await session.exec("printf 'still-alive\n'");

    expect(readResult.exitCode).not.toBe(0);
    expect(readResult.stdout).toBe('');
    expect(nextResult.exitCode).toBe(0);
    expect(nextResult.stdout).toBe('still-alive\n');
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
