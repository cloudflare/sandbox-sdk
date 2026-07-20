/**
 * SDK-side extensions unit tests.
 *
 * Exercises `SandboxExtension`: lazy construction, scoped runtime access, and
 * the hash-first sidecar connect dance against the extension host.
 *
 * Container-side end-to-end coverage lives in
 * `packages/sandbox-container/tests/extensions/extension-host.test.ts`.
 */

import type {
  ExtensionConnectRequest,
  ExtensionHealth,
  ExtensionPackage,
  SandboxExtensionsAPI,
  SandboxUtilsAPI
} from '@repo/shared';
import { EXTENSION_TARBALL_REQUIRED } from '@repo/shared';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtensionRuntimeCall,
  ExtensionRuntimeControl
} from '../src/extensions';
import {
  SandboxExtension,
  type SandboxLike,
  sandboxRuntimeCall
} from '../src/extensions';

type ExtensionsAPIMock = {
  connect: Mock<SandboxExtensionsAPI['connect']>;
  health: Mock<SandboxExtensionsAPI['health']>;
  stop: Mock<SandboxExtensionsAPI['stop']>;
};

type UtilsAPIMock = {
  ping: Mock<SandboxUtilsAPI['ping']>;
};

type RuntimeScope = {
  operation: string;
  control: ExtensionRuntimeControl;
};

function makeSandbox(): {
  sandbox: SandboxLike;
  api: ExtensionsAPIMock;
  utils: UtilsAPIMock;
  scopes: RuntimeScope[];
} {
  const api: ExtensionsAPIMock = {
    connect: vi.fn(async () => ({}) as unknown),
    health: vi.fn(async () => ({}) as ExtensionHealth),
    stop: vi.fn(async () => {})
  };
  const utils: UtilsAPIMock = {
    ping: vi.fn(async () => 'pong')
  };
  const scopes: RuntimeScope[] = [];
  const runtimeCall = (async (operation, call) => {
    const control = {
      files: { domain: 'files' },
      ports: { domain: 'ports' },
      backup: { domain: 'backup' },
      watch: { domain: 'watch' },
      tunnels: { domain: 'tunnels' },
      terminals: { domain: 'terminals' },
      extensions: api as unknown as SandboxExtensionsAPI,
      utils: utils as unknown as SandboxUtilsAPI
    } as unknown as ExtensionRuntimeControl;
    scopes.push({ operation, control });
    return await call(control);
  }) as ExtensionRuntimeCall;
  const sandbox: SandboxLike = {
    [sandboxRuntimeCall]: runtimeCall
  };
  return { sandbox, api, utils, scopes };
}

const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

const PKG: ExtensionPackage = { tarball: TARBALL };

describe('SandboxExtension', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  class DummyExtension extends SandboxExtension {
    // biome-ignore lint/complexity/noUselessConstructor: widens the protected base constructor
    constructor(sandbox: SandboxLike) {
      super(sandbox);
    }
    health(packageHash: string) {
      return this.withRuntime('dummy.health', (control) =>
        control.extensions.health(packageHash)
      );
    }

    pingTwice() {
      return this.withRuntime('dummy.pingTwice', async (control) => {
        const first = await control.utils.ping();
        const second = await control.utils.ping();
        return `${first}:${second}`;
      });
    }
  }

  class TypeContractExtension extends SandboxExtension {
    // biome-ignore lint/complexity/noUselessConstructor: widens the protected base constructor
    constructor(sandbox: SandboxLike) {
      super(sandbox);
    }

    escapeControl() {
      return this.withRuntime(
        'type.escape.control',
        // @ts-expect-error runtime control must not be returned from withRuntime
        async (control) => control
      );
    }

    escapeFiles() {
      return this.withRuntime(
        'type.escape.files',
        // @ts-expect-error runtime control domains must not be returned from withRuntime
        async (control) => control.files
      );
    }

    escapeExtensions() {
      return this.withRuntime(
        'type.escape.extensions',
        // @ts-expect-error runtime control domains must not be returned from withRuntime
        async (control) => control.extensions
      );
    }
  }

  void TypeContractExtension;

  class EscapeExtension extends SandboxExtension {
    constructor(sandbox: SandboxLike) {
      super(sandbox, PKG);
    }

    escapeControl() {
      return this.withRuntime(
        'escape.control',
        async (control) => control as unknown as object
      );
    }

    escapeDomain(domain: keyof ExtensionRuntimeControl) {
      return this.withRuntime(
        'escape.domain',
        async (control) => control[domain] as unknown as object
      );
    }

    ordinaryObject() {
      return this.withRuntime('escape.ordinaryObject', async () => ({
        ok: true
      }));
    }
  }

  it('captures the sandbox without exposing it as an own property (RPC-safe)', () => {
    const { sandbox } = makeSandbox();
    const ext = new DummyExtension(sandbox);

    expect(Object.getOwnPropertyNames(ext)).not.toContain('sandbox');
    expect(Object.getOwnPropertyNames(ext)).not.toContain('client');
    expect(Object.keys(ext)).toHaveLength(0);
  });

  it('uses scoped runtime callbacks for direct control access', async () => {
    const { sandbox, api, utils, scopes } = makeSandbox();
    api.health.mockResolvedValue({
      packageHash: 'abc123',
      id: 'ext',
      version: '1.0.0',
      provisioned: true,
      running: true,
      pid: 123,
      responsive: true
    });
    const ext = new DummyExtension(sandbox);

    await expect(ext.health('abc123')).resolves.toMatchObject({
      packageHash: 'abc123',
      running: true,
      pid: 123
    });
    await expect(ext.pingTwice()).resolves.toBe('pong:pong');

    expect(api.health).toHaveBeenCalledWith('abc123');
    expect(utils.ping).toHaveBeenCalledTimes(2);
    expect(scopes.map((scope) => scope.operation)).toEqual([
      'dummy.health',
      'dummy.pingTwice'
    ]);
    expect(scopes[0].control).not.toBe(scopes[1].control);
  });

  it('keeps multiple control calls inside one explicit runtime scope', async () => {
    const { sandbox, utils, scopes } = makeSandbox();
    const ext = new DummyExtension(sandbox);

    await expect(ext.pingTwice()).resolves.toBe('pong:pong');

    expect(utils.ping).toHaveBeenCalledTimes(2);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].operation).toBe('dummy.pingTwice');
  });

  it('rejects cast attempts to escape runtime control handles', async () => {
    const { sandbox } = makeSandbox();
    const ext = new EscapeExtension(sandbox);

    await expect(ext.escapeControl()).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('files')).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('ports')).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('backup')).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('watch')).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('tunnels')).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('terminals')).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('extensions')).rejects.toThrow(
      /must not return runtime control handles/
    );
    await expect(ext.escapeDomain('utils')).rejects.toThrow(
      /must not return runtime control handles/
    );
  });

  it('allows ordinary objects to leave runtime callbacks', async () => {
    const { sandbox } = makeSandbox();
    const ext = new EscapeExtension(sandbox);

    await expect(ext.ordinaryObject()).resolves.toEqual({ ok: true });
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
    const { sandbox, api, scopes } = makeSandbox();

    class Ext extends SandboxExtension {
      constructor(s: SandboxLike) {
        super(s, PKG);
      }
    }
    new Ext(sandbox);

    expect(api.connect).not.toHaveBeenCalled();
    expect(api.health).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(scopes).toHaveLength(0);
  });
});

describe('SandboxExtension (sidecar mode)', () => {
  interface FakeAPI {
    do(input: string): Promise<string>;
  }

  function buildExt() {
    const { sandbox, api, scopes } = makeSandbox();
    class Ext extends SandboxExtension {
      constructor(s: SandboxLike) {
        super(s, PKG);
      }
      async run(input: string) {
        const stub = await this.sidecar<FakeAPI>();
        return stub.do(input);
      }
      async captureSidecar() {
        return await this.sidecar<FakeAPI>();
      }
      health() {
        return this.sidecarHealth();
      }
      stop() {
        return this.stopSidecar();
      }
    }
    return { ext: new Ext(sandbox), api, scopes };
  }

  it('sends the hash alone on first connect; retries with tarball on ExtensionTarballRequired in one scope', async () => {
    const { ext, api, scopes } = buildExt();
    const fakeStub = { do: vi.fn(async (s: string) => `did:${s}`) };

    api.connect
      .mockImplementationOnce(async () => {
        const err = new Error('need tarball');
        (err as { name: string }).name = EXTENSION_TARBALL_REQUIRED;
        throw err;
      })
      .mockImplementationOnce(async () => fakeStub);

    const result = await ext.run('hi');
    expect(result).toBe('did:hi');

    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(scopes.map((scope) => scope.operation)).toEqual([
      'extension.connect'
    ]);
    const first = api.connect.mock.calls[0][0] as ExtensionConnectRequest;
    const second = api.connect.mock.calls[1][0] as ExtensionConnectRequest;

    expect(first.tarball).toBeUndefined();
    expect(first.packageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.tarball).toBeInstanceOf(Uint8Array);
    expect(second.packageHash).toBe(first.packageHash);
  });

  it('retries when capnweb wraps ExtensionTarballRequired as RPCTransportError', async () => {
    const { ext, api, scopes } = buildExt();
    const fakeStub = { do: vi.fn(async (s: string) => `did:${s}`) };

    api.connect
      .mockRejectedValueOnce(
        new Error(
          "RPCTransportError: Extension package '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' is not provisioned; resend connect() with tarball bytes"
        )
      )
      .mockResolvedValueOnce(fakeStub);

    await expect(ext.run('hi')).resolves.toBe('did:hi');
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(scopes).toHaveLength(1);
    const second = api.connect.mock.calls[1][0] as ExtensionConnectRequest;
    expect(second.tarball).toBeInstanceOf(Uint8Array);
  });

  it('adds a diagnostic helper when sidecar provisioning fails after tarball retry', async () => {
    const { ext, api, scopes } = buildExt();
    api.connect
      .mockRejectedValueOnce(
        new Error(
          "RPCTransportError: Extension package '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' is not provisioned; resend connect() with tarball bytes"
        )
      )
      .mockRejectedValueOnce(new Error('bun add failed'));

    await expect(ext.run('hi')).rejects.toThrow(
      /Failed to provision sandbox sidecar package.*valid npm-style \.tgz.*bun add failed/
    );
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(scopes).toHaveLength(1);
  });

  it('opens a new runtime scope for each sidecar call without reconnecting captured stubs', async () => {
    const { ext, api, scopes } = buildExt();
    let firstRuntimeActive = true;
    const firstStub = {
      do: vi.fn(async (s: string) => {
        if (!firstRuntimeActive) throw new Error('stale sidecar');
        return `first:${s}`;
      })
    };
    const secondStub = { do: vi.fn(async (s: string) => `second:${s}`) };
    api.connect
      .mockResolvedValueOnce(firstStub)
      .mockResolvedValueOnce(secondStub);

    const captured = await ext.captureSidecar();
    await expect(captured.do('a')).resolves.toBe('first:a');
    firstRuntimeActive = false;
    await expect(captured.do('again')).rejects.toThrow(/stale sidecar/);
    await expect(ext.run('b')).resolves.toBe('second:b');

    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(firstStub.do).toHaveBeenCalledTimes(2);
    expect(secondStub.do).toHaveBeenCalledTimes(1);
    expect(scopes.map((scope) => scope.operation)).toEqual([
      'extension.connect',
      'extension.connect'
    ]);
  });

  it('retries cleanly after a failed connect', async () => {
    const { ext, api, scopes } = buildExt();
    const fakeStub = { do: vi.fn(async (s: string) => `did:${s}`) };
    api.connect
      .mockRejectedValueOnce(new Error('connect failed'))
      .mockResolvedValueOnce(fakeStub);

    await expect(ext.run('a')).rejects.toThrow(/connect failed/);
    await expect(ext.run('b')).resolves.toBe('did:b');
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(scopes.map((scope) => scope.operation)).toEqual([
      'extension.connect',
      'extension.connect'
    ]);
  });

  it('does not retry on a non-ExtensionTarballRequired error', async () => {
    const { ext, api, scopes } = buildExt();
    api.connect.mockRejectedValueOnce(new Error('something else'));

    await expect(ext.run('a')).rejects.toThrow(/something else/);
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(scopes).toHaveLength(1);
  });

  it('forwards health by package hash in its own scope', async () => {
    const { ext, api, scopes } = buildExt();
    await ext.health();
    expect(api.health).toHaveBeenCalledTimes(1);
    expect(scopes.map((scope) => scope.operation)).toEqual([
      'extension.health'
    ]);
    const arg = api.health.mock.calls[0][0];
    expect(typeof arg).toBe('string');
    expect(arg).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stopSidecar stops the host-side sidecar and the next call reconnects', async () => {
    const { ext, api, scopes } = buildExt();
    const fakeStub = { do: vi.fn(async (s: string) => `did:${s}`) };
    api.connect.mockResolvedValue(fakeStub);

    await ext.run('warm');
    await ext.stop();
    await ext.run('after');

    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(scopes.map((scope) => scope.operation)).toEqual([
      'extension.connect',
      'extension.stop',
      'extension.connect'
    ]);
  });
});
