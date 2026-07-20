/**
 * SandboxControlCallbackImpl unit tests.
 *
 * The class is the capnweb-facing RpcTarget the DO exposes via
 * `localMain`. It routes tunnel-run exit notifications through to the
 * `TunnelExitHandler` it was given. TunnelService owns the exit
 * reconciliation behavior.
 */

import type { Logger } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeIdentity } from '../src/runtime';
import type { TunnelExitHandler } from '../src/tunnels/rpc-target';
import { SandboxControlCallbackImpl } from '../src/tunnels/sandbox-control-callback';

const runtime = new RuntimeIdentity({
  id: 'runtime-1' as RuntimeIdentity['id'],
  runtimeIncarnationID: 'inc-1' as RuntimeIdentity['runtimeIncarnationID']
});

function makeCallback(
  getHandler: () => TunnelExitHandler | null
): SandboxControlCallbackImpl {
  return new SandboxControlCallbackImpl(
    getHandler,
    makeLogger(),
    runtime,
    async () => runtime,
    () => true
  );
}

function makeLogger(): Logger {
  const log: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => log)
  } as unknown as Logger;
  return log;
}

describe('SandboxControlCallbackImpl', () => {
  it('routes onTunnelRunExit events through to the bound handler', async () => {
    const handler = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    const cb = makeCallback(() => handler);

    await cb.onTunnelRunExit({
      tunnelId: 'quick-a',
      runId: 'run-a',
      mode: 'quick',
      port: 8080,
      exitCode: 0
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      'quick-a',
      8080,
      0,
      'run-a',
      runtime,
      expect.any(Function)
    );
  });

  it('passes through a null exitCode', async () => {
    const handler = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    const cb = makeCallback(() => handler);

    await cb.onTunnelRunExit({
      tunnelId: 'quick-b',
      runId: 'run-b',
      mode: 'quick',
      port: 8081,
      exitCode: null
    });

    expect(handler).toHaveBeenCalledWith(
      'quick-b',
      8081,
      null,
      'run-b',
      runtime,
      expect.any(Function)
    );
  });

  it('is a no-op when the accessor returns null', async () => {
    const cb = new SandboxControlCallbackImpl(() => null, makeLogger());

    await expect(
      cb.onTunnelRunExit({
        tunnelId: 'quick-c',
        runId: 'run-c',
        mode: 'quick',
        port: 8082,
        exitCode: 0
      })
    ).resolves.toBeUndefined();
  });

  it('reads the handler accessor every call', async () => {
    let current: TunnelExitHandler | null = null;
    const cb = makeCallback(() => current);

    await cb.onTunnelRunExit({
      tunnelId: 'quick-d',
      runId: 'run-d-1',
      mode: 'quick',
      port: 8083,
      exitCode: 0
    });

    const handler = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    current = handler;
    await cb.onTunnelRunExit({
      tunnelId: 'quick-d',
      runId: 'run-d-2',
      mode: 'quick',
      port: 8083,
      exitCode: 0
    });
    expect(handler).toHaveBeenCalledTimes(1);

    const newer = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    current = newer;
    await cb.onTunnelRunExit({
      tunnelId: 'quick-d',
      runId: 'run-d-3',
      mode: 'quick',
      port: 8083,
      exitCode: 0
    });
    expect(newer).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores callbacks after the activated runtime is replaced', async () => {
    const handler = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    const replacement = new RuntimeIdentity({
      id: runtime.id,
      runtimeIncarnationID: 'inc-2' as RuntimeIdentity['runtimeIncarnationID']
    });
    const cb = new SandboxControlCallbackImpl(
      () => handler,
      makeLogger(),
      runtime,
      async () => replacement,
      () => true
    );

    await cb.onTunnelRunExit({
      tunnelId: 'quick-stale',
      runId: 'run-stale',
      mode: 'quick',
      port: 8084,
      exitCode: 0
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates handler errors to the caller', async () => {
    const handler = vi
      .fn<TunnelExitHandler>()
      .mockRejectedValue(new Error('storage boom'));
    const cb = makeCallback(() => handler);

    await expect(
      cb.onTunnelRunExit({
        tunnelId: 'quick-e',
        runId: 'run-e',
        mode: 'quick',
        port: 8084,
        exitCode: 0
      })
    ).rejects.toThrow('storage boom');
  });
});
