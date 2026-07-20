import type { SandboxControlCallback, TunnelRunExitEvent } from '@repo/shared';
import type { RpcTarget } from 'capnweb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerControlConnection } from '../../src/container-control/connection';
import { RuntimeControlProtocolError } from '../../src/errors';
import type { RuntimeIncarnationID } from '../../src/runtime';
import { RuntimeIdentity, RuntimeSessionManager } from '../../src/runtime';
import type { RuntimeIdentityID } from '../../src/runtime/types';
import { SandboxControlCallbackImpl } from '../../src/tunnels/sandbox-control-callback';

const runtime = (id: string, incarnation: string) =>
  new RuntimeIdentity({
    id: id as RuntimeIdentityID,
    runtimeIncarnationID: incarnation as RuntimeIncarnationID
  });

const metadata = (incarnation: string) => ({
  runtimeIncarnationID: incarnation,
  sandboxVersion: '0.0.0',
  controlProtocolVersion: 1 as const
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('RuntimeSessionManager', () => {
  it('sequential acquire after retain/release reuses cached activation', async () => {
    const activate = vi
      .spyOn(ContainerControlConnection.prototype, 'activateControlSession')
      .mockResolvedValue(metadata('incarnation-1'));
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });
    const expected = runtime('runtime-1', 'incarnation-1');

    const first = await manager.acquireSession(expected);
    const hold = first.retain();
    hold.release();
    hold.release();
    const second = await manager.acquireSession(expected);

    expect(second).toBe(first);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('reuses the same activated session for the same runtime identity and incarnation', async () => {
    const activate = vi
      .spyOn(ContainerControlConnection.prototype, 'activateControlSession')
      .mockResolvedValue(metadata('incarnation-1'));
    vi.spyOn(
      ContainerControlConnection.prototype,
      'disconnect'
    ).mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });
    const expected = runtime('runtime-1', 'incarnation-1');

    const first = await manager.acquire(expected);
    const second = await manager.acquire(expected);

    expect(first).toBe(second);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('force-releases multiple holds and callbacks once on supersession', async () => {
    vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    ).mockImplementation(async (incarnation) => metadata(incarnation));
    vi.spyOn(
      ContainerControlConnection.prototype,
      'disconnect'
    ).mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });
    const first = await manager.acquireSession(
      runtime('runtime-1', 'incarnation-1')
    );
    const firstInterrupted = vi.fn();
    const secondInterrupted = vi.fn();
    const firstHold = first.retain(firstInterrupted);
    const secondHold = first.retain(secondInterrupted);

    await manager.acquireSession(runtime('runtime-2', 'incarnation-2'));
    firstHold.release();
    secondHold.release();

    expect(firstInterrupted).toHaveBeenCalledTimes(1);
    expect(secondInterrupted).toHaveBeenCalledTimes(1);
    expect(first.isInterrupted()).toBe(true);
  });

  it('force-releases holds and callbacks once on closeActive and transport close', async () => {
    vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    ).mockResolvedValue(metadata('incarnation-1'));
    vi.spyOn(
      ContainerControlConnection.prototype,
      'disconnect'
    ).mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });
    const first = await manager.acquireSession(
      runtime('runtime-1', 'incarnation-1')
    );
    const closeInterrupted = vi.fn();
    first.retain(closeInterrupted);
    manager.closeActive();
    expect(closeInterrupted).toHaveBeenCalledTimes(1);

    const second = await manager.acquireSession(
      runtime('runtime-1', 'incarnation-1')
    );
    const transportInterrupted = vi.fn();
    second.retain(transportInterrupted);
    const cached = manager as unknown as {
      cached: { connection: { onClose?: () => void } } | null;
    };
    cached.cached?.connection.onClose?.();
    expect(transportInterrupted).toHaveBeenCalledTimes(1);
  });

  it('interrupted sessions fail closed for later retain without leaking holds', async () => {
    vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    ).mockResolvedValue(metadata('incarnation-1'));
    vi.spyOn(
      ContainerControlConnection.prototype,
      'disconnect'
    ).mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });
    const session = await manager.acquireSession(
      runtime('runtime-1', 'incarnation-1')
    );
    manager.closeActive();
    const interrupted = vi.fn();
    const lateHold = session.retain(interrupted);
    lateHold.release();

    expect(interrupted).toHaveBeenCalledTimes(1);
  });

  it('disconnects and reactivates when either runtime identity dimension changes', async () => {
    const activate = vi
      .spyOn(ContainerControlConnection.prototype, 'activateControlSession')
      .mockImplementation(async (incarnation) => metadata(incarnation));
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });

    const first = await manager.acquire(runtime('runtime-1', 'incarnation-1'));
    const second = await manager.acquire(runtime('runtime-1', 'incarnation-2'));
    const third = await manager.acquire(runtime('runtime-2', 'incarnation-2'));

    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    expect(activate).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('globally fences concurrent openings so superseded R1 cannot publish after R2', async () => {
    const r1 = deferred<ReturnType<typeof metadata>>();
    const activate = vi
      .spyOn(ContainerControlConnection.prototype, 'activateControlSession')
      .mockImplementation((incarnation) =>
        incarnation === 'incarnation-1'
          ? r1.promise
          : Promise.resolve(metadata('incarnation-2'))
      );
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });

    const stale = manager.acquire(runtime('runtime-1', 'incarnation-1'));
    expect(disconnect).not.toHaveBeenCalled();
    const freshPromise = manager.acquire(runtime('runtime-2', 'incarnation-2'));
    expect(disconnect).toHaveBeenCalledTimes(1);
    const fresh = await freshPromise;
    r1.resolve(metadata('incarnation-1'));

    await expect(stale).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    await expect(
      manager.acquire(runtime('runtime-2', 'incarnation-2'))
    ).resolves.toBe(fresh);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalled();
  });

  it('closeActive poisons current sessions but allows later acquire', async () => {
    const pending = deferred<ReturnType<typeof metadata>>();
    const activate = vi
      .spyOn(ContainerControlConnection.prototype, 'activateControlSession')
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(metadata('incarnation-1'));
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });

    const opening = manager.acquire(runtime('runtime-1', 'incarnation-1'));
    manager.closeActive();
    pending.resolve(metadata('incarnation-1'));

    await expect(opening).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    await expect(
      manager.acquire(runtime('runtime-1', 'incarnation-1'))
    ).resolves.toBeDefined();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalled();
  });

  it('dispose poisons an in-flight opening so it cannot publish or return', async () => {
    const pending = deferred<ReturnType<typeof metadata>>();
    vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    ).mockReturnValue(pending.promise);
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });

    const opening = manager.acquire(runtime('runtime-1', 'incarnation-1'));
    expect(disconnect).not.toHaveBeenCalled();
    manager.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
    pending.resolve(metadata('incarnation-1'));

    await expect(opening).rejects.toMatchObject({
      name: 'RuntimeIdentityInactiveError'
    });
    await expect(
      manager.acquire(runtime('runtime-1', 'incarnation-1'))
    ).rejects.toThrow(/disposed/);
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not arm idle teardown for manager-owned activated sessions', async () => {
    vi.useFakeTimers();
    const activate = vi
      .spyOn(ContainerControlConnection.prototype, 'activateControlSession')
      .mockResolvedValue(metadata('incarnation-1'));
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });

    const client = await manager.acquire(runtime('runtime-1', 'incarnation-1'));
    const cached = manager as unknown as {
      cached: { connection: { state: 'active' } } | null;
    };
    if (cached.cached) cached.cached.connection.state = 'active';
    await client.connect();
    vi.advanceTimersByTime(10_000);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('invalidates cache on connection close and reactivates next acquire', async () => {
    const activate = vi
      .spyOn(ContainerControlConnection.prototype, 'activateControlSession')
      .mockResolvedValue(metadata('incarnation-1'));
    vi.spyOn(
      ContainerControlConnection.prototype,
      'disconnect'
    ).mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });
    const expected = runtime('runtime-1', 'incarnation-1');

    const first = await manager.acquire(expected);
    const cached = manager as unknown as {
      cached: { connection: { onClose?: () => void } } | null;
    };
    cached.cached?.connection.onClose?.();
    const second = await manager.acquire(expected);

    expect(second).not.toBe(first);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('closes a mismatched activation before exposing a client', async () => {
    vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    ).mockResolvedValue(metadata('incarnation-2'));
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });

    await expect(
      manager.acquire(runtime('runtime-1', 'incarnation-1'))
    ).rejects.toBeInstanceOf(RuntimeControlProtocolError);
    expect(disconnect).toHaveBeenCalled();
  });

  it('adapts CONTROL_PROTOCOL_INCOMPATIBLE activation failures', async () => {
    const error = new Error('Runtime incarnation does not match') as Error & {
      code: string;
    };
    error.code = 'CONTROL_PROTOCOL_INCOMPATIBLE';
    vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    ).mockRejectedValue(error);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() })
    });

    await expect(
      manager.acquire(runtime('runtime-1', 'incarnation-1'))
    ).rejects.toMatchObject({
      name: 'RuntimeControlProtocolError',
      context: { reason: 'activation-mismatch' }
    });
  });

  it('passes a callback target bound to the expected runtime identity', async () => {
    const handled = vi.fn();
    const expectedRuntime = runtime('runtime-1', 'incarnation-1');
    let current = runtime('runtime-1', 'incarnation-2');
    const callback = new SandboxControlCallbackImpl(
      () => handled,
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          child: vi.fn()
        })
      },
      undefined,
      () => current
    );
    const bindRuntime = vi.spyOn(callback, 'bindRuntime');
    vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    ).mockResolvedValue(metadata('incarnation-1'));
    vi.spyOn(
      ContainerControlConnection.prototype,
      'disconnect'
    ).mockImplementation(() => undefined);
    const manager = new RuntimeSessionManager({
      getTcpPort: () => ({ fetch: vi.fn() }),
      callbackBinder: (runtimeIdentity, isSessionCurrent) =>
        callback.bindRuntime(runtimeIdentity, isSessionCurrent)
    });

    await manager.acquire(expectedRuntime);
    expect(bindRuntime).toHaveBeenCalledWith(
      expectedRuntime,
      expect.any(Function)
    );
    const bound = bindRuntime.mock.results[0]?.value as SandboxControlCallback &
      RpcTarget;
    await bound.onTunnelRunExit({
      tunnelId: 'tunnel',
      runId: 'run',
      mode: 'quick',
      port: 3000,
      exitCode: 1
    } as TunnelRunExitEvent);

    expect(handled).not.toHaveBeenCalled();
    current = expectedRuntime;
    await bound.onTunnelRunExit({
      tunnelId: 'tunnel',
      runId: 'run',
      mode: 'quick',
      port: 3000,
      exitCode: 1
    } as TunnelRunExitEvent);
    expect(handled).toHaveBeenCalledTimes(1);

    manager.closeActive();
    await bound.onTunnelRunExit({
      tunnelId: 'tunnel',
      runId: 'run',
      mode: 'quick',
      port: 3000,
      exitCode: 1
    } as TunnelRunExitEvent);
    expect(handled).toHaveBeenCalledTimes(1);
  });
});
