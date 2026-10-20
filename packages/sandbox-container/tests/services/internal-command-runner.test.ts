import { describe, expect, it, jest } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InternalCommandRunner } from '../../src/services/internal-command-runner';

// Waits in real time, which fake timers do not advance.
async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await Bun.file(path).exists()) return;
    Bun.sleepSync(10);
  }
  throw new Error(`${path} did not appear within 5 seconds`);
}

describe('InternalCommandRunner', () => {
  it('kills a command that ignores SIGTERM once the grace period ends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'internal-command-runner-'));
    const trapped = join(dir, 'trapped');
    jest.useFakeTimers();
    try {
      const run = new InternalCommandRunner().run(
        `trap '' TERM; printf ready; : > ${trapped}; sleep 30; printf done`,
        { cwd: '/tmp', timeoutMs: 1_000 }
      );
      let settled = false;
      void run.finally(() => {
        settled = true;
      });

      // The runner's clock stands still while the login shell starts, so the
      // timeout fires only after the command has installed its trap. Then
      // step the clock through the timeout and the SIGTERM grace period.
      await waitForFile(trapped);
      while (!settled) {
        jest.advanceTimersByTime(1_000);
        await new Promise((resolve) => setImmediate(resolve));
      }

      const result = await run;
      expect(result).toMatchObject({
        success: false,
        exitCode: 124,
        stdout: 'ready'
      });
      expect(result.stderr).toContain('Command timed out after 1000ms');
    } finally {
      jest.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
