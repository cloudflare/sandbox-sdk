// packages/sandbox/tests/opencode/persistence.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type OpenCodeStateStorage,
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
    getProcess: vi.fn().mockResolvedValue(null),
    containerFetch: vi.fn().mockResolvedValue(new Response('ok'))
  } as unknown as Sandbox;
}

/** In-memory fake of the storage slice the handle uses. */
function createFakeStorage(): OpenCodeStateStorage & {
  map: Map<string, unknown>;
  put: ReturnType<typeof vi.fn>;
} {
  const map = new Map<string, unknown>();
  const put = vi.fn(async (key: string, value: unknown) => {
    map.set(key, value);
  });
  return {
    map,
    put,
    get: async <T>(key: string): Promise<T | undefined> =>
      map.get(key) as T | undefined
  };
}

describe('OpenCode desired-state persistence', () => {
  let storage: ReturnType<typeof createFakeStorage>;

  beforeEach(() => {
    storage = createFakeStorage();
  });

  it('persists resolved options on ensure', async () => {
    const sandbox = createMockSandbox();
    const handle = withOpenCode(sandbox, { directory: '/agents' }, storage);

    await handle.ensure({ port: 8080 });

    expect(storage.put).toHaveBeenCalled();
    const persisted = [...storage.map.values()][0];
    expect(persisted).toMatchObject({ directory: '/agents', port: 8080 });
  });

  it('recovers persisted desired-state on a cold start', async () => {
    // First instance starts a server, persisting its resolved options.
    const first = createMockSandbox();
    await withOpenCode(first, {}, storage).ensure({
      port: 8080,
      directory: '/agents'
    });

    // Fresh instance (cold DO) shares the same storage but no in-memory state.
    const second = createMockSandbox();
    const revived = withOpenCode(second, {}, storage);

    await revived.onContainerStart();

    expect(second.startProcess).toHaveBeenCalledWith(
      'cd /agents && opencode serve --port 8080 --hostname 0.0.0.0',
      expect.any(Object)
    );
  });

  it('does not start a server on cold start when nothing was persisted', async () => {
    const sandbox = createMockSandbox();
    const handle = withOpenCode(sandbox, {}, storage);

    await handle.onContainerStart();

    expect(sandbox.startProcess).not.toHaveBeenCalled();
  });

  it('works without storage (in-memory only)', async () => {
    const sandbox = createMockSandbox();
    const handle = withOpenCode(sandbox, { directory: '/agents' });

    await expect(handle.ensure()).resolves.toMatchObject({ port: 4096 });
  });

  it('keys handles separately so two servers both recover', async () => {
    const first = createMockSandbox();
    const a = withOpenCode(first, {}, storage);
    const b = withOpenCode(first, {}, storage);
    await a.ensure({ port: 4096 });
    await b.ensure({ port: 5000 });

    const second = createMockSandbox();
    const a2 = withOpenCode(second, {}, storage);
    const b2 = withOpenCode(second, {}, storage);
    await a2.onContainerStart();
    await b2.onContainerStart();

    const commands = (
      second.startProcess as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[0]);
    expect(commands).toContain('opencode serve --port 4096 --hostname 0.0.0.0');
    expect(commands).toContain('opencode serve --port 5000 --hostname 0.0.0.0');
  });
});
