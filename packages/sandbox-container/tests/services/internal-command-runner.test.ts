import { describe, expect, it } from 'bun:test';
import { InternalCommandRunner } from '../../src/services/internal-command-runner';

describe('InternalCommandRunner', () => {
  it('bounds timeout cleanup when the command ignores SIGTERM', async () => {
    const runner = new InternalCommandRunner();
    const started = performance.now();

    const result = await runner.run(
      "trap '' TERM; printf ready; sleep 4; printf done",
      { cwd: '/tmp', timeoutMs: 200 }
    );

    expect(performance.now() - started).toBeLessThan(2_500);
    expect(result).toMatchObject({
      success: false,
      exitCode: 124,
      stdout: 'ready'
    });
    expect(result.stderr).toContain('Command timed out after 200ms');
  }, 5_000);
});
