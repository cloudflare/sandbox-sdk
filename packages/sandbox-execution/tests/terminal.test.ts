import { describe, expect, it } from 'bun:test';
import { Terminal } from '../src/index';

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

describe('Terminal', () => {
  it('captures interactive PTY transcript without structured stdio', async () => {
    await using terminal = await Terminal.create({ cwd: '/tmp' });

    terminal.write('pwd\n');
    await waitForCondition(() => terminal.capture().includes('/tmp'));

    expect(terminal.capture()).toContain('pwd');
    expect(terminal.capture()).toContain('/tmp');
    expect('exec' in terminal).toBe(false);
  });

  it('supports terminal input for prompts', async () => {
    await using terminal = await Terminal.create();

    terminal.write("read -p 'Name: ' name; echo Hello-$name\n");
    await waitForCondition(() => terminal.capture().includes('Name: '));
    terminal.write('Ada\n');
    await waitForCondition(() => terminal.capture().includes('Hello-Ada'));

    expect(terminal.capture()).toContain('Name: ');
    expect(terminal.capture()).toContain('Hello-Ada');
  });
});
