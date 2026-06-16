import { describe, expect, it } from 'bun:test';
import { CommandSession, type StdioChunk } from '../src/index';

function collect(output: StdioChunk[], stream: StdioChunk['stream']): string {
  return output
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join('');
}

function isPIDAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('CommandSession', () => {
  it('preserves shell state and returns final stdout and stderr', async () => {
    await using session = await CommandSession.create({ cwd: '/tmp' });

    const first = await session.exec(
      'mkdir -p sandbox-execution-test && cd sandbox-execution-test && pwd'
    );
    const second = await session.exec(
      "printf 'out\n'; printf 'err\n' >&2; pwd"
    );

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('/tmp/sandbox-execution-test');
    expect(first.stderr).toBe('');
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('out\n');
    expect(second.stdout).toContain('/tmp/sandbox-execution-test');
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

  it('applies per-command cwd without mutating session cwd', async () => {
    await using session = await CommandSession.create();

    const scoped = await session.exec('pwd', { cwd: '/tmp' });
    const persisted = await session.exec('pwd');

    expect(scoped.exitCode).toBe(0);
    expect(scoped.stdout.trim()).toBe('/tmp');
    expect(persisted.exitCode).toBe(0);
    expect(persisted.stdout.trim()).toBe('/workspace');
  });

  it('does not run a command when per-command cwd is invalid', async () => {
    await using session = await CommandSession.create();

    const result = await session.exec('printf should-not-run', {
      cwd: '/definitely/missing/sandbox/session/path'
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('/definitely/missing/sandbox/session/path');
  });

  it('applies per-command env without mutating session env', async () => {
    await using session = await CommandSession.create();

    const scoped = await session.exec('printf "$SCOPED_ENV"', {
      env: { SCOPED_ENV: 'from-call' }
    });
    const persisted = await session.exec('printf "$SCOPED_ENV"');

    expect(scoped.exitCode).toBe(0);
    expect(scoped.stdout).toBe('from-call');
    expect(persisted.exitCode).toBe(0);
    expect(persisted.stdout).toBe('');
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

  it('starts a process from session state without writing back mutations', async () => {
    await using session = await CommandSession.create({ cwd: '/tmp' });

    await session.exec(String.raw`mkdir -p sandbox-process-test && cd sandbox-process-test
export PROCESS_VALUE=original
alias say_process='printf "alias:%s\n" "$PROCESS_VALUE"'
process_func() { printf "func:%s\n" "$PROCESS_VALUE"; }`);

    const process = await session.startProcess(`pwd
say_process
process_func
export PROCESS_VALUE=changed
cd /`);
    const result = await process.wait();
    const afterProcess = await session.exec(
      'pwd; printf "%s\n" "$PROCESS_VALUE"'
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      '/tmp/sandbox-process-test\nalias:original\nfunc:original\n'
    );
    expect(result.stderr).toBe('');
    expect(afterProcess.stdout).toBe('/tmp/sandbox-process-test\noriginal\n');
  });

  it('streams process output before completion', async () => {
    await using session = await CommandSession.create();
    const streamed: StdioChunk[] = [];
    const firstOutput = Promise.withResolvers<void>();

    const process = await session.startProcess(
      String.raw`printf 'before-sleep\n'; sleep 1; printf 'after-sleep\n'; printf 'err\n' >&2`,
      {
        onOutput: (chunk) => {
          streamed.push(chunk);
          if (
            chunk.stream === 'stdout' &&
            chunk.data.includes('before-sleep')
          ) {
            firstOutput.resolve();
          }
        }
      }
    );

    await Promise.race([
      firstOutput.promise,
      Bun.sleep(750).then(() => {
        throw new Error('Timed out waiting for live process output');
      })
    ]);
    const stateAfterFirstOutput = await Promise.race([
      process.wait().then(() => 'settled'),
      Bun.sleep(100).then(() => 'pending')
    ]);
    const result = await process.wait();
    expect(stateAfterFirstOutput).toBe('pending');
    expect(result.exitCode).toBe(0);
    expect(collect(streamed, 'stdout')).toBe('before-sleep\nafter-sleep\n');
    expect(collect(streamed, 'stderr')).toBe('err\n');
    expect(result.stdout).toBe(collect(streamed, 'stdout'));
    expect(result.stderr).toBe(collect(streamed, 'stderr'));
  });

  it('kills a running process and keeps the session usable', async () => {
    await using session = await CommandSession.create();

    const process = await session.startProcess("printf 'started\n'; sleep 10");
    await process.kill();
    const result = await Promise.race([
      process.wait(),
      Bun.sleep(750).then(() => {
        throw new Error('Timed out waiting for killed process');
      })
    ]);
    const afterKill = await session.exec("printf 'session-alive\n'");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('started\n');
    expect(afterKill.exitCode).toBe(0);
    expect(afterKill.stdout).toBe('session-alive\n');
  });

  it('kills a process waiting on a foreground child', async () => {
    await using session = await CommandSession.create();

    const process = await session.startProcess(
      "printf 'started\n'; bash -c 'sleep 10'"
    );
    await process.kill();

    const result = await Promise.race([
      process.wait(),
      Bun.sleep(750).then(() => {
        throw new Error('Timed out waiting for killed child process');
      })
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('started\n');
  });

  it('kills background descendants of a process', async () => {
    await using session = await CommandSession.create();

    const process = await session.startProcess(
      'sleep 10 & printf \'child:%s\n\' "$!"; sleep 10'
    );
    const result = await Promise.race([
      process.wait(),
      Bun.sleep(750).then(async () => {
        await process.kill();
        return process.wait();
      })
    ]);
    const childPID = result.stdout.match(/child:(\d+)/)?.[1];
    expect(childPID).toBeDefined();

    const childStatus = await session.exec(`kill -0 ${childPID}`);
    expect(childStatus.exitCode).not.toBe(0);
  });

  it('times out a process tree and keeps the session usable', async () => {
    await using session = await CommandSession.create();

    const process = await session.startProcess(
      'sleep 10 & printf \'child:%s\nstarted\n\' "$!"; sleep 10',
      { timeoutMs: 100 }
    );

    const result = await Promise.race([
      process.wait(),
      Bun.sleep(1_000).then(() => {
        throw new Error('Timed out waiting for process timeout');
      })
    ]);
    const childPID = result.stdout.match(/child:(\d+)/)?.[1];
    expect(childPID).toBeDefined();

    const childStatus = await session.exec(`kill -0 ${childPID}`);
    const afterTimeout = await session.exec("printf 'session-alive\n'");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('started\n');
    expect(childStatus.exitCode).not.toBe(0);
    expect(afterTimeout.exitCode).toBe(0);
    expect(afterTimeout.stdout).toBe('session-alive\n');
  });

  it('clears process timeout after normal completion', async () => {
    await using session = await CommandSession.create();

    const process = await session.startProcess("printf 'quick\n'", {
      timeoutMs: 100
    });
    const result = await process.wait();
    await Bun.sleep(200);
    const afterTimeoutWindow = await session.exec("printf 'session-alive\n'");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('quick\n');
    expect(afterTimeoutWindow.exitCode).toBe(0);
    expect(afterTimeoutWindow.stdout).toBe('session-alive\n');
  });

  it('closes active process trees when closing the session', async () => {
    const session = await CommandSession.create();
    const childPID = Promise.withResolvers<number>();

    const runningProcess = await session.startProcess(
      'sleep 10 & printf \'child:%s\n\' "$!"; sleep 10',
      {
        onOutput: (chunk) => {
          const pid = chunk.data.match(/child:(\d+)/)?.[1];
          if (pid) {
            childPID.resolve(Number.parseInt(pid, 10));
          }
        }
      }
    );
    const pid = await Promise.race([
      childPID.promise,
      Bun.sleep(750).then(() => {
        throw new Error('Timed out waiting for child PID');
      })
    ]);

    const waitForProcess = runningProcess.wait();

    await session.close();
    const result = await waitForProcess;

    expect(result.exitCode).not.toBe(0);
    expect(isPIDAlive(pid)).toBe(false);
  });

  it('aborts a process tree and keeps the session usable', async () => {
    await using session = await CommandSession.create();
    const controller = new AbortController();

    const process = await session.startProcess(
      'sleep 10 & printf \'child:%s\nstarted\n\' "$!"; sleep 10',
      { signal: controller.signal }
    );
    controller.abort();

    const result = await Promise.race([
      process.wait(),
      Bun.sleep(1_000).then(() => {
        throw new Error('Timed out waiting for aborted process');
      })
    ]);
    const childPID = result.stdout.match(/child:(\d+)/)?.[1];
    expect(childPID).toBeDefined();

    const childStatus = await session.exec(`kill -0 ${childPID}`);
    const afterAbort = await session.exec("printf 'session-alive\n'");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('started\n');
    expect(childStatus.exitCode).not.toBe(0);
    expect(afterAbort.exitCode).toBe(0);
    expect(afterAbort.stdout).toBe('session-alive\n');
  });

  it('rejects startProcess when the signal is already aborted', async () => {
    await using session = await CommandSession.create();
    const controller = new AbortController();
    controller.abort();

    await expect(
      session.startProcess("printf 'should-not-run\n'", {
        signal: controller.signal
      })
    ).rejects.toThrow('Process start aborted');

    const afterAbort = await session.exec("printf 'session-alive\n'");
    expect(afterAbort.exitCode).toBe(0);
    expect(afterAbort.stdout).toBe('session-alive\n');
  });

  it('removes abort listener after process completion', async () => {
    await using session = await CommandSession.create();
    const controller = new AbortController();

    const process = await session.startProcess("printf 'quick\n'", {
      signal: controller.signal
    });
    const result = await process.wait();
    controller.abort();
    await Bun.sleep(100);
    const afterAbort = await session.exec("printf 'session-alive\n'");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('quick\n');
    expect(afterAbort.exitCode).toBe(0);
    expect(afterAbort.stdout).toBe('session-alive\n');
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

  it('terminates active process trees when command timeout fails the session', async () => {
    const session = await CommandSession.create();
    const childPID = Promise.withResolvers<number>();

    try {
      const runningProcess = await session.startProcess(
        'sleep 10 & printf \'child:%s\n\' "$!"; sleep 10',
        {
          onOutput: (chunk) => {
            const pid = chunk.data.match(/child:(\d+)/)?.[1];
            if (pid) {
              childPID.resolve(Number.parseInt(pid, 10));
            }
          }
        }
      );
      const pid = await Promise.race([
        childPID.promise,
        Bun.sleep(750).then(() => {
          throw new Error('Timed out waiting for child PID');
        })
      ]);
      const waitForProcess = runningProcess.wait();
      waitForProcess.catch(() => {});

      await expect(session.exec('sleep 10', { timeoutMs: 50 })).rejects.toThrow(
        'Timed out waiting for command'
      );
      await expect(waitForProcess).rejects.toThrow(
        'Timed out waiting for command'
      );

      expect(isPIDAlive(pid)).toBe(false);
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

  it('terminates active process trees when shell exit fails the session', async () => {
    const session = await CommandSession.create();
    const childPID = Promise.withResolvers<number>();

    try {
      const runningProcess = await session.startProcess(
        'sleep 10 & printf \'child:%s\n\' "$!"; sleep 10',
        {
          onOutput: (chunk) => {
            const pid = chunk.data.match(/child:(\d+)/)?.[1];
            if (pid) {
              childPID.resolve(Number.parseInt(pid, 10));
            }
          }
        }
      );
      const pid = await Promise.race([
        childPID.promise,
        Bun.sleep(750).then(() => {
          throw new Error('Timed out waiting for child PID');
        })
      ]);
      const waitForProcess = runningProcess.wait();
      waitForProcess.catch(() => {});

      await expect(session.exec('exit')).rejects.toThrow(
        'Command session shell exited'
      );
      const result = await waitForProcess;

      expect(result.exitCode).not.toBe(0);
      expect(isPIDAlive(pid)).toBe(false);
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
