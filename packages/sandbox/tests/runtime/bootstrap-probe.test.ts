import { describe, expect, it, vi } from 'vitest';
import { ContainerControlConnection } from '../../src/container-control/connection';
import { RuntimeControlProtocolError } from '../../src/errors';
import { RuntimeBootstrapProbe } from '../../src/runtime/bootstrap-probe';

const metadata = {
  runtimeIncarnationID: 'incarnation-1',
  sandboxVersion: '0.0.0',
  controlProtocolVersion: 1 as const
};

describe('RuntimeBootstrapProbe', () => {
  it('uses direct port access, reads metadata, and always disconnects', async () => {
    const directStub = { fetch: vi.fn() };
    const getTcpPort = vi.fn(() => directStub);
    const connect = vi
      .spyOn(ContainerControlConnection.prototype, 'connect')
      .mockResolvedValue(undefined);
    const readMetadata = vi
      .spyOn(ContainerControlConnection.prototype, 'getRuntimeMetadata')
      .mockResolvedValue(metadata);
    const activate = vi.spyOn(
      ContainerControlConnection.prototype,
      'activateControlSession'
    );
    const disconnect = vi
      .spyOn(ContainerControlConnection.prototype, 'disconnect')
      .mockImplementation(() => undefined);

    await expect(
      new RuntimeBootstrapProbe({ getTcpPort }).probe()
    ).resolves.toEqual(metadata);

    expect(getTcpPort).toHaveBeenCalledWith(3000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(readMetadata).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('adapts unsupported metadata to RuntimeControlProtocolError', async () => {
    vi.spyOn(ContainerControlConnection.prototype, 'connect').mockResolvedValue(
      undefined
    );
    vi.spyOn(
      ContainerControlConnection.prototype,
      'getRuntimeMetadata'
    ).mockResolvedValue({
      ...metadata,
      controlProtocolVersion: 2 as 1
    });
    vi.spyOn(
      ContainerControlConnection.prototype,
      'disconnect'
    ).mockImplementation(() => undefined);

    await expect(
      new RuntimeBootstrapProbe({
        getTcpPort: () => ({ fetch: vi.fn() })
      }).probe()
    ).rejects.toBeInstanceOf(RuntimeControlProtocolError);
  });
});
