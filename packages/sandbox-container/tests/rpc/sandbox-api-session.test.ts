import { describe, expect, it, vi } from 'bun:test';
import {
  ErrorCode,
  type RuntimeMetadata,
  type SandboxControlCallback
} from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import { ControlSession } from '@sandbox-container/control-plane/session';

const metadata: RuntimeMetadata = {
  runtimeIncarnationID: 'runtime-1',
  sandboxVersion: '1.2.3',
  controlProtocolVersion: 1
};

function createAPI(connectionID = 'conn-1', callback?: SandboxControlCallback) {
  const fileService = {
    exists: vi.fn().mockResolvedValue({ success: true, data: true })
  };
  const registerControlCallback = vi.fn();
  const clearControlCallback = vi.fn();
  const session = new ControlSession({
    metadata,
    connectionID,
    peerCallback: callback,
    registerControlCallback,
    clearControlCallback
  });
  const api = new SandboxControlAPI(
    {
      fileService
    } as unknown as SandboxAPIDeps,
    session
  );
  return {
    api,
    fileService,
    registerControlCallback,
    clearControlCallback,
    session
  };
}

async function expectIncompatible(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    code: ErrorCode.CONTROL_PROTOCOL_INCOMPATIBLE
  });
}

describe('SandboxControlAPI session activation', () => {
  it('returns stable process metadata before activation', async () => {
    const { api } = createAPI();

    await expect(api.utils.ping()).resolves.toBe('healthy');
    await expect(api.utils.getRuntimeMetadata()).resolves.toEqual(metadata);
    await expect(api.utils.getRuntimeMetadata()).resolves.toBe(
      await api.utils.getRuntimeMetadata()
    );
  });

  it('rejects all non-utils domains before activation', async () => {
    const { api, fileService } = createAPI();
    const gatedDomains = [
      'files',
      'ports',
      'processes',
      'terminals',
      'backup',
      'mounts',
      'tunnels',
      'watch',
      'workspace',
      'extensions'
    ] as const;

    for (const domain of gatedDomains) {
      expect(() => api[domain]).toThrow(
        expect.objectContaining({
          code: ErrorCode.CONTROL_PROTOCOL_INCOMPATIBLE
        })
      );
    }
    expect(fileService.exists).not.toHaveBeenCalled();
  });

  it('rejects activation for the wrong incarnation', async () => {
    const { api, registerControlCallback } = createAPI();

    await expectIncompatible(api.utils.activateControlSession('runtime-2'));
    expect(registerControlCallback).not.toHaveBeenCalled();
  });

  it('activates idempotently only for the matching incarnation', async () => {
    const callback = { onTunnelRunExit: vi.fn() };
    const { api, registerControlCallback } = createAPI('conn-1', callback);

    await expect(
      api.utils.activateControlSession('runtime-1')
    ).resolves.toEqual(metadata);
    await expect(
      api.files.exists('/workspace/file.txt')
    ).resolves.toMatchObject({
      success: true,
      exists: true
    });
    await expect(
      api.utils.activateControlSession('runtime-1')
    ).resolves.toEqual(metadata);
    await expectIncompatible(api.utils.activateControlSession('runtime-2'));
    expect(registerControlCallback).toHaveBeenCalledTimes(1);
    expect(registerControlCallback).toHaveBeenCalledWith('conn-1', callback);
  });

  it('rejects first activation after the session closes', async () => {
    const { api, session, registerControlCallback } = createAPI();
    session.close();

    await expectIncompatible(api.utils.activateControlSession('runtime-1'));
    expect(registerControlCallback).not.toHaveBeenCalled();
  });

  it('registers callbacks only after successful activation', async () => {
    const callback = { onTunnelRunExit: vi.fn() };
    const { api, registerControlCallback } = createAPI('conn-1', callback);

    expect(registerControlCallback).not.toHaveBeenCalled();
    await api.utils.activateControlSession('runtime-1');
    expect(registerControlCallback).toHaveBeenCalledWith('conn-1', callback);
  });

  it('clears callback ownership only for the matching connection', async () => {
    const firstCallback = { onTunnelRunExit: vi.fn() };
    const secondCallback = { onTunnelRunExit: vi.fn() };
    let current: {
      connectionID: string;
      callback: SandboxControlCallback;
    } | null = null;
    const registerControlCallback = vi.fn(
      (connectionID: string, callback: SandboxControlCallback) => {
        current = { connectionID, callback };
      }
    );
    const clearControlCallback = vi.fn((connectionID: string) => {
      if (current?.connectionID === connectionID) current = null;
    });
    const session1 = new ControlSession({
      metadata,
      connectionID: 'conn-1',
      peerCallback: firstCallback,
      registerControlCallback,
      clearControlCallback
    });
    const session2 = new ControlSession({
      metadata,
      connectionID: 'conn-2',
      peerCallback: secondCallback,
      registerControlCallback,
      clearControlCallback
    });

    await session1.activate('runtime-1');
    await session2.activate('runtime-1');
    session1.close();
    expect(current as unknown).toEqual({
      connectionID: 'conn-2',
      callback: secondCallback
    });
    await session1.activate('runtime-1');
    expect(current as unknown).toEqual({
      connectionID: 'conn-2',
      callback: secondCallback
    });
    session2.close();
    expect(current).toBeNull();
  });
});
