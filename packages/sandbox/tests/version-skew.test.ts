import {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  type SandboxRuntimeInfo
} from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';

type MockRPC = {
  runtime?: {
    getRuntimeInfo?: () => Promise<SandboxRuntimeInfo>;
  };
  commands?: Record<string, unknown>;
  terminals?: unknown;
};

let mockRpc: MockRPC;

vi.mock('../src/container-control/connection', () => ({
  ContainerControlConnection: class {
    setRetryTimeoutMs() {}
    isConnected() {
      return true;
    }
    getStats() {
      return { imports: 1, exports: 1 };
    }
    disconnect() {}
    rpc() {
      return mockRpc;
    }
    async connect() {}
  }
}));

import { ContainerControlClient } from '../src/container-control/client';
import { ErrorCode } from '../src/errors';

function createClient(): ContainerControlClient {
  return new ContainerControlClient({ stub: { fetch: vi.fn() } });
}

function useRuntime(info: SandboxRuntimeInfo): ReturnType<typeof vi.fn> {
  const getRuntimeInfo = vi.fn().mockResolvedValue(info);
  mockRpc = { runtime: { getRuntimeInfo } };
  return getRuntimeInfo;
}

function addCommand(): ReturnType<typeof vi.fn> {
  const execute = vi.fn().mockResolvedValue({
    success: true,
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    command: 'echo ok',
    timestamp: '2026-06-29T00:00:00.000Z'
  });
  mockRpc.commands = { execute };
  return execute;
}

async function expectVersionMismatch(promise: Promise<unknown>): Promise<{
  code: string;
  httpStatus: number;
  context: Record<string, unknown>;
}> {
  try {
    await promise;
  } catch (err) {
    expect(err).toHaveProperty('name', 'ContainerVersionMismatchError');
    expect(err).toHaveProperty('code', ErrorCode.CONTAINER_VERSION_MISMATCH);
    expect(err).toHaveProperty('httpStatus', 500);
    return err as {
      code: string;
      httpStatus: number;
      context: Record<string, unknown>;
    };
  }
  throw new Error('Expected ContainerVersionMismatchError');
}

describe('sandbox container compatibility handshake', () => {
  it('rejects connect when the runtime handshake is missing', async () => {
    mockRpc = {};

    await expectVersionMismatch(createClient().connect());
  });

  it('rejects connect when the container reports an unsupported protocol', async () => {
    useRuntime({
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION + 1,
      containerVersion: 'newer-container'
    });

    const error = await expectVersionMismatch(createClient().connect());

    expect(error.context).toMatchObject({
      containerVersion: 'newer-container',
      containerProtocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION + 1,
      supportedProtocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION
    });
  });

  it('checks compatibility once before RPC calls on a connection', async () => {
    const getRuntimeInfo = useRuntime({
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      containerVersion: 'matching-container'
    });
    const execute = addCommand();
    const client = createClient();

    await expect(client.commands.execute('echo ok')).resolves.toMatchObject({
      stdout: 'ok\n'
    });
    await client.commands.execute('echo ok');

    expect(getRuntimeInfo).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reports version mismatch before touching old container RPC domains', async () => {
    mockRpc = { terminals: undefined };
    const client = createClient();

    await expectVersionMismatch(
      (
        client.terminals as unknown as {
          createTerminal: () => Promise<unknown>;
        }
      ).createTerminal()
    );
  });
});
