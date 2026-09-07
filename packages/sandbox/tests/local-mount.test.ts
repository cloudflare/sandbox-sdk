import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalMountSyncManager } from '../src/local-mount-sync';
import { Sandbox } from '../src/sandbox';

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    sleepAfter: string | number = '10m';

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  ContainerProxy: class {},
  getContainer: vi.fn(),
  switchPort: vi.fn()
}));

function createSandbox(): Sandbox {
  const state = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => state.get(key) ?? null),
    put: vi.fn(async (key: string, value: unknown) => state.set(key, value)),
    delete: vi.fn(async (key: string) => state.delete(key)),
    list: vi.fn(async () => new Map()),
    transaction: vi.fn(async (callback: (value: unknown) => unknown) =>
      callback(storage)
    )
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) =>
      callback()
    ),
    waitUntil: vi.fn(),
    container: { running: true, start: vi.fn() },
    id: { toString: () => 'test', equals: vi.fn(), name: 'test' }
  };
  const sandbox = new Sandbox(
    ctx as unknown as ConstructorParameters<typeof Sandbox>[0],
    {
      WORKSPACE: {
        put: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        delete: vi.fn(),
        list: vi.fn()
      } as unknown as R2Bucket
    } as unknown as Cloudflare.Env
  );
  Object.assign(sandbox, {
    ensureDefaultSession: vi.fn(async () => 'session'),
    client: {}
  });
  return sandbox;
}

describe('Sandbox local bucket mounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(LocalMountSyncManager.prototype, 'start').mockResolvedValue();
    vi.spyOn(LocalMountSyncManager.prototype, 'stop').mockResolvedValue();
  });

  it('reuses only an identical active mount', async () => {
    const sandbox = createSandbox();
    const options = { localBucket: true as const, prefix: '/workspace/' };

    await sandbox.mountBucket('WORKSPACE', '/mnt/data', options);
    await expect(
      sandbox.mountBucket('WORKSPACE', '/mnt/data', options)
    ).resolves.toBeUndefined();
    expect(LocalMountSyncManager.prototype.start).toHaveBeenCalledTimes(1);

    await expect(
      sandbox.mountBucket('WORKSPACE', '/mnt/data', {
        ...options,
        readOnly: true
      })
    ).rejects.toThrow(/Mount path already in use/);
  });

  it('replaces a mount from an older container generation', async () => {
    const sandbox = createSandbox();
    await sandbox.mountBucket('WORKSPACE', '/mnt/data', { localBucket: true });

    (sandbox as unknown as { containerGeneration: number })
      .containerGeneration++;
    await sandbox.mountBucket('WORKSPACE', '/mnt/data', { localBucket: true });

    expect(LocalMountSyncManager.prototype.stop).toHaveBeenCalledTimes(1);
    expect(LocalMountSyncManager.prototype.start).toHaveBeenCalledTimes(2);
  });
});
