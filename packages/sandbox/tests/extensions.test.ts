/**
 * SDK-side extensions unit tests.
 *
 * Exercises `SandboxExtension`: lazy construction, the hash-first connect
 * dance against `client.extensions`, and reconnect-on-use sidecar semantics.
 *
 * Container-side end-to-end coverage lives in
 * `packages/sandbox-container/tests/extensions/extension-host.test.ts`.
 */

import type {
  ExtensionConnectRequest,
  ExtensionHealth,
  ExtensionPackage,
  SandboxExtensionsAPI
} from '@repo/shared';
import { EXTENSION_TARBALL_REQUIRED } from '@repo/shared';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxExtension, type SandboxLike } from '../src/extensions';

type ExtensionsAPIMock = {
  connect: Mock<SandboxExtensionsAPI['connect']>;
  health: Mock<SandboxExtensionsAPI['health']>;
  stop: Mock<SandboxExtensionsAPI['stop']>;
};

function makeSandbox(): {
  sandbox: SandboxLike;
  api: ExtensionsAPIMock;
} {
  const api: ExtensionsAPIMock = {
    connect: vi.fn(async () => ({}) as unknown),
    health: vi.fn(async () => ({}) as ExtensionHealth),
    stop: vi.fn(async () => {})
  };
  // The tests only ever exercise `client.extensions`; widening to SandboxAPI
  // would force us to stub every sub-API for no benefit.
  const sandbox = {
    client: { extensions: api as unknown as SandboxExtensionsAPI }
  } as unknown as SandboxLike;
  return { sandbox, api };
}

const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip magic + flags, plenty enough to hash

const PKG: ExtensionPackage = { tarball: TARBALL };

describe('SandboxExtension', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  class Commands extends SandboxExtension {
    // biome-ignore lint/complexity/noUselessConstructor: widens the protected base constructor
    constructor(sandbox: SandboxLike) {
      super(sandbox);
    }
    list() {
      return (
        this.client as unknown as { commands: { exec: () => unknown } }
      ).commands.exec();
    }
  }

  it('captures the sandbox without exposing it as an own property (RPC-safe)', () => {
    const sandbox = { client: {} } as unknown as SandboxLike;
    const ext = new Commands(sandbox);

    expect(Object.getOwnPropertyNames(ext)).not.toContain('sandbox');
    expect(Object.getOwnPropertyNames(ext)).not.toContain('client');
    expect(Object.keys(ext)).toHaveLength(0);
  });

  it('exposes the control client to subclasses lazily', () => {
    const exec = vi.fn(() => 'ok');
    const sandbox = {
      client: { commands: { exec } }
    } as unknown as SandboxLike;
    const ext = new Commands(sandbox);

    expect(ext.list()).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('throws a helpful error if sidecar methods are used without a package', async () => {
    class NoPackage extends SandboxExtension {
      // biome-ignore lint/complexity/noUselessConstructor: widens the protected base constructor
      constructor(sandbox: SandboxLike) {
        super(sandbox);
      }
      run() {
        return this.sidecar();
      }
      health() {
        return this.sidecarHealth();
      }
      stop() {
        return this.stopSidecar();
      }
    }
    const { sandbox, api } = makeSandbox();
    const ext = new NoPackage(sandbox);

    await expect(ext.run()).rejects.toThrow(/no sidecar package/i);
    await expect(ext.health()).rejects.toThrow(/no sidecar package/i);
    await expect(ext.stop()).rejects.toThrow(/no sidecar package/i);
    expect(api.stop).not.toHaveBeenCalled();
  });

  it('does not touch the sandbox during construction (lazy)', () => {
    const { sandbox, api } = makeSandbox();

    class Ext extends SandboxExtension {
      constructor(s: SandboxLike) {
        super(s, PKG);
      }
    }
    new Ext(sandbox);

    expect(api.connect).not.toHaveBeenCalled();
    expect(api.health).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });
});

describe('SandboxExtension (sidecar mode)', () => {
  interface FakeAPI {
    do(input: string): Promise<string>;
  }

  function buildExt() {
    const { sandbox, api } = makeSandbox();
    class Ext extends SandboxExtension {
      constructor(s: SandboxLike) {
        super(s, PKG);
      }
      async run(input: string) {
        const stub = await this.sidecar<FakeAPI>();
        return stub.do(input);
      }
      health() {
        return this.sidecarHealth();
      }
      stop() {
        return this.stopSidecar();
      }
    }
    return { ext: new Ext(sandbox), api };
  }

  it('sends the hash alone on first connect; retries with tarball on ExtensionTarballRequired', async () => {
    const { ext, api } = buildExt();
    const fakeStub = { do: vi.fn(async (s: string) => `did:${s}`) };

    api.connect
      .mockImplementationOnce(async () => {
        // Host has not provisioned this hash yet.
        const err = new Error('need tarball');
        (err as { name: string }).name = EXTENSION_TARBALL_REQUIRED;
        throw err;
      })
      .mockImplementationOnce(async () => fakeStub);

    const result = await ext.run('hi');
    expect(result).toBe('did:hi');

    expect(api.connect).toHaveBeenCalledTimes(2);
    const first = api.connect.mock.calls[0][0] as ExtensionConnectRequest;
    const second = api.connect.mock.calls[1][0] as ExtensionConnectRequest;

    expect(first.tarball).toBeUndefined();
    expect(first.packageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.tarball).toBeInstanceOf(Uint8Array);
    expect(second.packageHash).toBe(first.packageHash);
  });

  it('reconnects through the host on each sidecar call', async () => {
    const { ext, api } = buildExt();
    const firstStub = { do: vi.fn(async (s: string) => `first:${s}`) };
    const secondStub = { do: vi.fn(async (s: string) => `second:${s}`) };
    api.connect
      .mockResolvedValueOnce(firstStub)
      .mockResolvedValueOnce(secondStub);

    await expect(ext.run('a')).resolves.toBe('first:a');
    await expect(ext.run('b')).resolves.toBe('second:b');

    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(firstStub.do).toHaveBeenCalledTimes(1);
    expect(secondStub.do).toHaveBeenCalledTimes(1);
  });

  it('retries cleanly after a failed connect', async () => {
    const { ext, api } = buildExt();
    const fakeStub = { do: vi.fn(async (s: string) => `did:${s}`) };
    api.connect
      .mockRejectedValueOnce(new Error('connect failed'))
      .mockResolvedValueOnce(fakeStub);

    await expect(ext.run('a')).rejects.toThrow(/connect failed/);
    await expect(ext.run('b')).resolves.toBe('did:b');
    expect(api.connect).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a non-ExtensionTarballRequired error', async () => {
    const { ext, api } = buildExt();
    api.connect.mockRejectedValueOnce(new Error('something else'));

    await expect(ext.run('a')).rejects.toThrow(/something else/);
    expect(api.connect).toHaveBeenCalledTimes(1);
  });

  it('forwards health by package hash', async () => {
    const { ext, api } = buildExt();
    await ext.health();
    expect(api.health).toHaveBeenCalledTimes(1);
    const arg = api.health.mock.calls[0][0];
    expect(typeof arg).toBe('string');
    expect(arg).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stopSidecar stops the host-side sidecar and the next call reconnects', async () => {
    const { ext, api } = buildExt();
    const fakeStub = { do: vi.fn(async (s: string) => `did:${s}`) };
    api.connect.mockResolvedValue(fakeStub);

    await ext.run('warm');
    await ext.stop();
    await ext.run('after');

    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(api.stop).toHaveBeenCalledTimes(1);
  });
});
