/**
 * SandboxControlCallbackImpl unit tests.
 *
 * The class is the capnweb-facing RpcTarget the DO exposes via
 * `localMain`. It does almost nothing on its own — just routes
 * `onTunnelExit` through to the `TunnelExitHandler` it was given.
 * TunnelService owns the exit reconciliation behavior.
 */

import type { Logger } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { TunnelExitHandler } from '../src/tunnels/rpc-target';
import { SandboxControlCallbackImpl } from '../src/tunnels/sandbox-control-callback';

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
  it('routes onTunnelExit through to the bound handler', async () => {
    const handler = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    const cb = new SandboxControlCallbackImpl(() => handler, makeLogger());

    await cb.onTunnelExit('quick-a', 8080, 0, 'run-a');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('quick-a', 8080, 0, 'run-a');
  });

  it('passes through a null exitCode (signalled process)', async () => {
    const handler = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    const cb = new SandboxControlCallbackImpl(() => handler, makeLogger());

    await cb.onTunnelExit('quick-b', 8081, null);

    expect(handler).toHaveBeenCalledWith('quick-b', 8081, null, undefined);
  });

  it('is a no-op when the accessor returns null', async () => {
    const cb = new SandboxControlCallbackImpl(() => null, makeLogger());

    // Must not throw — the accessor returning null models a callback
    // arriving before the lazy getter has built the tunnel subsystem.
    await expect(cb.onTunnelExit('quick-c', 8082, 0)).resolves.toBeUndefined();
  });

  it('reads the handler accessor every call (does not cache)', async () => {
    let current: TunnelExitHandler | null = null;
    const cb = new SandboxControlCallbackImpl(() => current, makeLogger());

    // First call: no handler bound. No-op.
    await cb.onTunnelExit('quick-d', 8083, 0);

    // Bind a handler, fire again. Must invoke the newly bound handler.
    const handler = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    current = handler;
    await cb.onTunnelExit('quick-d', 8083, 0);
    expect(handler).toHaveBeenCalledTimes(1);

    // Swap to a different handler (simulating a transport rebind).
    const newer = vi.fn<TunnelExitHandler>().mockResolvedValue(undefined);
    current = newer;
    await cb.onTunnelExit('quick-d', 8083, 0);
    expect(newer).toHaveBeenCalledTimes(1);
    // The original handler was not called again.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('propagates handler errors to the caller', async () => {
    const handler = vi
      .fn<TunnelExitHandler>()
      .mockRejectedValue(new Error('storage boom'));
    const cb = new SandboxControlCallbackImpl(() => handler, makeLogger());

    await expect(cb.onTunnelExit('quick-e', 8084, 0)).rejects.toThrow(
      'storage boom'
    );
  });
});
