import type { TunnelInfo } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createTunnelsHandle,
  type TunnelsStorage
} from '../../src/tunnels/rpc-target';
import { TunnelService } from '../../src/tunnels/tunnel-service';
import { makeLogger, makeStorage } from './helpers';

type TunnelsHost = Parameters<typeof createTunnelsHandle>[0];

function makeRuntimeCall(): TunnelsHost['runRuntimeCall'] {
  const tunnels = {
    ensureTunnelRun: vi.fn(),
    stopTunnelRun: vi.fn()
  };
  return (_operation, call) =>
    call(
      tunnels as unknown as Parameters<
        Parameters<TunnelsHost['runRuntimeCall']>[1]
      >[0]
    );
}

function makeService(storage: TunnelsStorage): TunnelService {
  return new TunnelService({
    runRuntimeCall: makeRuntimeCall(),
    storage,
    logger: makeLogger()
  });
}

function quickTunnel(): TunnelInfo {
  return {
    id: 'quick-12345678',
    port: 8080,
    url: 'https://quick.trycloudflare.com',
    hostname: 'quick.trycloudflare.com',
    createdAt: '2026-06-22T00:00:00.000Z'
  };
}

function namedTunnel(): TunnelInfo {
  return {
    id: 'named-tunnel-id',
    port: 9090,
    name: 'app',
    url: 'https://app.example.com',
    hostname: 'app.example.com',
    createdAt: '2026-06-22T00:00:00.000Z'
  };
}

function makeRestartStorage(
  meta: Record<string, unknown> = {}
): TunnelsStorage {
  return makeStorage({
    tunnels: {
      '8080': quickTunnel(),
      '9090': namedTunnel()
    },
    'tunnels:meta': {
      '8080': { optionsHash: 'v1:quick' },
      '9090': { optionsHash: 'v1:named:app', ...meta }
    }
  });
}

async function expectRestartReconciled(storage: TunnelsStorage): Promise<void> {
  await expect(storage.get('tunnels')).resolves.toEqual({});
  await expect(storage.get('tunnels:meta')).resolves.toEqual({
    '9090': expect.objectContaining({
      optionsHash: 'v1:named:app',
      tunnelId: 'named-tunnel-id',
      name: 'app',
      hostname: 'app.example.com',
      needsRespawn: true
    })
  });
}

describe('TunnelService', () => {
  it.each([
    [
      'runtime start',
      async (handle: ReturnType<typeof createTunnelsHandle>) =>
        handle.onRuntimeStart()
    ],
    [
      'runtime stop',
      async (handle: ReturnType<typeof createTunnelsHandle>) =>
        handle.onRuntimeStop()
    ]
  ])(
    'exposes %s reconciliation through the handle factory',
    async (_label, run) => {
      const storage = makeRestartStorage();
      const handle = createTunnelsHandle({
        runRuntimeCall: makeRuntimeCall(),
        storage,
        logger: makeLogger()
      });

      await run(handle);

      await expectRestartReconciled(storage);
    }
  );

  it('preserves named metadata while reconciling a runtime restart', async () => {
    const storage = makeRestartStorage({
      dnsRecordId: 'dns-record-id',
      accountId: 'account-id',
      zoneId: 'zone-id'
    });
    const service = makeService(storage);

    await service.onRuntimeStart();

    await expect(storage.get('tunnels')).resolves.toEqual({});
    await expect(storage.get('tunnels:meta')).resolves.toEqual({
      '9090': {
        optionsHash: 'v1:named:app',
        dnsRecordId: 'dns-record-id',
        accountId: 'account-id',
        zoneId: 'zone-id',
        tunnelId: 'named-tunnel-id',
        name: 'app',
        hostname: 'app.example.com',
        needsRespawn: true
      }
    });
  });

  it('clears cleanup records with tunnel state after sandbox destroy', async () => {
    const storage = makeStorage({
      tunnels: { '8080': quickTunnel() },
      'tunnels:meta': { '8080': { optionsHash: 'v1:quick' } },
      'tunnels:cleanup': {
        '9090': {
          tunnelId: 'named-tunnel-id',
          port: 9090,
          name: 'app',
          hostname: 'app.example.com',
          phase: 'claimed',
          updatedAt: '2026-06-22T00:00:00.000Z'
        }
      }
    });
    const service = makeService(storage);

    await service.clearDurableStateAfterDestroy();

    await expect(storage.get('tunnels')).resolves.toBeUndefined();
    await expect(storage.get('tunnels:meta')).resolves.toBeUndefined();
    await expect(storage.get('tunnels:cleanup')).resolves.toBeUndefined();
  });
});
