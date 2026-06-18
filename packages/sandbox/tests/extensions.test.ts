/**
 * SDK extensions client unit tests.
 *
 * Exercises the thin wrapper over `sandbox.client.extensions`: lazy
 * construction, method delegation, and the bounded readiness retry.
 */

import type {
  ExtensionHealth,
  ExtensionManifest,
  SandboxExtensionsAPI
} from '@repo/shared';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SandboxExtension,
  type SandboxLike,
  withExtensions
} from '../src/extensions';

type ExtensionsApiMock = {
  register: Mock<SandboxExtensionsAPI['register']>;
  call: Mock<SandboxExtensionsAPI['call']>;
  callStream: Mock<SandboxExtensionsAPI['callStream']>;
  health: Mock<SandboxExtensionsAPI['health']>;
  stop: Mock<SandboxExtensionsAPI['stop']>;
};

function makeSandbox(): {
  sandbox: { client: { extensions: SandboxExtensionsAPI } };
  api: ExtensionsApiMock;
} {
  const api: ExtensionsApiMock = {
    register: vi.fn(async () => {}),
    call: vi.fn(async () => undefined),
    callStream: vi.fn(async () => undefined),
    health: vi.fn(async () => ({}) as ExtensionHealth),
    stop: vi.fn(async () => {})
  };
  return {
    sandbox: { client: { extensions: api as unknown as SandboxExtensionsAPI } },
    api
  };
}

const MANIFEST: ExtensionManifest = {
  id: 'echo',
  version: '1',
  command: ['bun', '{dir}/echo.cjs']
};

describe('withExtensions', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not touch the client during construction (lazy)', () => {
    const { sandbox, api } = makeSandbox();
    withExtensions(sandbox);
    expect(api.register).not.toHaveBeenCalled();
    expect(api.call).not.toHaveBeenCalled();
  });

  it('delegates register / call / health / stop', async () => {
    const { sandbox, api } = makeSandbox();
    api.call.mockResolvedValue('pong');
    const ext = withExtensions(sandbox);

    await ext.register(MANIFEST);
    const result = await ext.call('echo', 'echo', ['hi']);
    await ext.health('echo');
    await ext.stop('echo');

    expect(api.register).toHaveBeenCalledWith(MANIFEST);
    expect(api.call).toHaveBeenCalledWith('echo', 'echo', ['hi']);
    expect(result).toBe('pong');
    expect(api.health).toHaveBeenCalledWith('echo');
    expect(api.stop).toHaveBeenCalledWith('echo');
  });

  it('defaults call args to an empty array', async () => {
    const { sandbox, api } = makeSandbox();
    const ext = withExtensions(sandbox);
    await ext.call('echo', 'ping');
    expect(api.call).toHaveBeenCalledWith('echo', 'ping', []);
  });

  it('forwards call timeouts when provided', async () => {
    const { sandbox, api } = makeSandbox();
    const ext = withExtensions(sandbox);
    await ext.call('echo', 'ping', [], { timeoutMs: 123 });
    expect(api.call).toHaveBeenCalledWith('echo', 'ping', [], 123);
  });

  it('streams events when onEvent is passed', async () => {
    const { sandbox, api } = makeSandbox();
    api.callStream.mockImplementation(async (_id, _m, _a, onEvent) => {
      await onEvent('echo', 'streamed');
      return 'streamed';
    });
    const ext = withExtensions(sandbox);

    const events: Array<{ event: string; data: unknown }> = [];
    const result = await ext.call('echo', 'echo', ['x'], {
      onEvent: (event, data) => void events.push({ event, data })
    });

    expect(result).toBe('streamed');
    expect(events).toEqual([{ event: 'echo', data: 'streamed' }]);
  });

  it('retries a readiness error then succeeds', async () => {
    vi.useFakeTimers();
    const { sandbox, api } = makeSandbox();
    api.call
      .mockRejectedValueOnce(
        new Error("Extension 'echo' bridge is not connected")
      )
      .mockResolvedValueOnce('ok');
    const ext = withExtensions(sandbox);

    const promise = ext.call('echo', 'echo', []);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(api.call).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-readiness errors', async () => {
    const { sandbox, api } = makeSandbox();
    api.call.mockRejectedValue(new Error('Unknown method: nope'));
    const ext = withExtensions(sandbox);

    await expect(ext.call('echo', 'nope', [])).rejects.toThrow(
      /Unknown method/
    );
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it('does not retry a streaming call once events have been emitted', async () => {
    const { sandbox, api } = makeSandbox();
    // Emit one event, then fail with a (broadly bridge-ish) error.
    api.callStream.mockImplementation(async (_id, _m, _a, onEvent) => {
      await onEvent('echo', 'partial');
      throw new Error('Extension bridge is not connected');
    });
    const ext = withExtensions(sandbox);

    const events: unknown[] = [];
    await expect(
      ext.call('echo', 'echo', [], {
        onEvent: (_e, d) => void events.push(d)
      })
    ).rejects.toThrow();
    // Exactly one attempt: the emitted-guard blocks the retry, so no dup events.
    expect(api.callStream).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['partial']);
  });

  it('does not retry a mid-life "socket closed" error', async () => {
    const { sandbox, api } = makeSandbox();
    api.call.mockRejectedValue(new Error('Extension bridge socket closed'));
    const ext = withExtensions(sandbox);

    await expect(ext.call('echo', 'echo', [])).rejects.toThrow(/socket closed/);
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting readiness retries', async () => {
    vi.useFakeTimers();
    const { sandbox, api } = makeSandbox();
    api.call.mockRejectedValue(
      new Error('sidecar did not accept a bridge connection')
    );
    const ext = withExtensions(sandbox);

    const promise = ext.call('echo', 'echo', []);
    const assertion = expect(promise).rejects.toThrow(/did not accept/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(api.call).toHaveBeenCalledTimes(3);
  });
});

describe('SandboxExtension', () => {
  class Commands extends SandboxExtension {
    // biome-ignore lint/complexity/noUselessConstructor: widens the base's protected constructor to public so the test can instantiate it
    constructor(sandbox: SandboxLike) {
      super(sandbox);
    }
    list() {
      // Reach an arbitrary control sub-API through the protected accessor.
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

  it('throws a helpful error if sidecar methods are used without a manifest', async () => {
    class NoManifest extends SandboxExtension {
      // biome-ignore lint/complexity/noUselessConstructor: widens the base's protected constructor to public so the test can instantiate it
      constructor(sandbox: SandboxLike) {
        super(sandbox);
      }
      run() {
        return this.call('whatever', []);
      }
    }
    const { sandbox } = makeSandbox();
    const ext = new NoManifest(sandbox as unknown as SandboxLike);

    await expect(ext.run()).rejects.toThrow(/no sidecar manifest/i);
  });
});

describe('SandboxExtension (sidecar mode)', () => {
  class Interpreter extends SandboxExtension {
    constructor(sandbox: SandboxLike) {
      super(sandbox, MANIFEST);
    }
    runCode(code: string) {
      return this.call('runCode', [code]);
    }
    stream(code: string, onEvent: (e: string, d: unknown) => void) {
      return this.call('runCode', [code], { onEvent });
    }
    status() {
      return this.health();
    }
    halt() {
      return this.stop();
    }
  }

  function makeInterpreter() {
    const { sandbox, api } = makeSandbox();
    return { ext: new Interpreter(sandbox as unknown as SandboxLike), api };
  }

  it('registers the manifest exactly once across multiple calls', async () => {
    const { ext, api } = makeInterpreter();
    api.call.mockResolvedValue('done');

    await ext.runCode('a');
    await ext.runCode('b');

    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.register).toHaveBeenCalledWith(MANIFEST);
  });

  it('binds the extension id on call', async () => {
    const { ext, api } = makeInterpreter();
    api.call.mockResolvedValue('42');

    const result = await ext.runCode('1+1');

    expect(result).toBe('42');
    expect(api.call).toHaveBeenCalledWith('echo', 'runCode', ['1+1']);
  });

  it('binds the extension id and forwards events when streaming', async () => {
    const { ext, api } = makeInterpreter();
    api.callStream.mockImplementation(async (_id, _m, _a, onEvent) => {
      await onEvent('stdout', 'hi');
      return 'ok';
    });

    const events: unknown[] = [];
    const result = await ext.stream('print(1)', (_e, d) => void events.push(d));

    expect(result).toBe('ok');
    expect(events).toEqual(['hi']);
    expect(api.callStream).toHaveBeenCalledWith(
      'echo',
      'runCode',
      ['print(1)'],
      expect.any(Function)
    );
  });

  it('registers before health and stop helpers', async () => {
    const { ext, api } = makeInterpreter();

    await ext.status();
    await ext.halt();

    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.health).toHaveBeenCalledWith('echo');
    expect(api.stop).toHaveBeenCalledWith('echo');
  });

  it('re-attempts registration after a failure', async () => {
    const { ext, api } = makeInterpreter();
    api.register
      .mockRejectedValueOnce(new Error('register failed'))
      .mockResolvedValueOnce(undefined);
    api.call.mockResolvedValue('ok');

    await expect(ext.runCode('a')).rejects.toThrow(/register failed/);
    await expect(ext.runCode('b')).resolves.toBe('ok');
    expect(api.register).toHaveBeenCalledTimes(2);
  });
});
