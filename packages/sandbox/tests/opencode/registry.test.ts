// packages/sandbox/tests/opencode/registry.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  reEnsureOpenCodeHandles,
  withOpenCode
} from '../../src/opencode/lifecycle';
import type { Sandbox } from '../../src/sandbox';

function createMockSandbox() {
  return {
    startProcess: vi.fn().mockResolvedValue({
      id: 'proc-1',
      command: 'opencode serve --port 4096 --hostname 0.0.0.0',
      status: 'running',
      startTime: new Date(),
      waitForPort: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    }),
    listProcesses: vi.fn().mockResolvedValue([]),
    containerFetch: vi.fn().mockResolvedValue(new Response('ok'))
  } as unknown as Sandbox;
}

describe('reEnsureOpenCodeHandles', () => {
  it('re-ensures every handle registered for the sandbox', async () => {
    const sandbox = createMockSandbox();
    const handle = withOpenCode(sandbox);
    const spy = vi.spyOn(handle, 'onContainerStart');

    await reEnsureOpenCodeHandles(sandbox);

    expect(spy).toHaveBeenCalledOnce();
  });

  it('does not cross handles between different sandboxes', async () => {
    const sandboxA = createMockSandbox();
    const sandboxB = createMockSandbox();
    const handleA = withOpenCode(sandboxA);
    const handleB = withOpenCode(sandboxB);
    const spyA = vi.spyOn(handleA, 'onContainerStart');
    const spyB = vi.spyOn(handleB, 'onContainerStart');

    await reEnsureOpenCodeHandles(sandboxA);

    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).not.toHaveBeenCalled();
  });

  it('is a no-op for a sandbox with no registered handles', async () => {
    const sandbox = createMockSandbox();

    await expect(reEnsureOpenCodeHandles(sandbox)).resolves.toBeUndefined();
  });
});
