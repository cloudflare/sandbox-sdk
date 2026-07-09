import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentityID } from '../src/current-runtime-identity';
import type { ResourceActivityOperation } from '../src/resource-activity-gate';

const constructed: Array<{
  options: {
    stub: { fetch(request: Request): Promise<Response> };
    retryTimeoutMs?: number;
    onOperationStarted?: () => ResourceActivityOperation;
    onConnectionClose?: () => void;
    onDispatch?: () => void;
    translateTransportErrorsAsInterruptions?: boolean;
  };
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../src/container-control/client', () => ({
  ContainerControlClient: class {
    disconnect = vi.fn();
    constructor(
      readonly options: {
        stub: { fetch(request: Request): Promise<Response> };
        retryTimeoutMs?: number;
        onOperationStarted?: () => ResourceActivityOperation;
        onConnectionClose?: () => void;
        onDispatch?: () => void;
        translateTransportErrorsAsInterruptions?: boolean;
      }
    ) {
      constructed.push({ options, disconnect: this.disconnect });
    }
  }
}));

import { RuntimeControlClient } from '../src/container-control/runtime-client';

function id(value: string): RuntimeIdentityID {
  return value as RuntimeIdentityID;
}

function noActivity(): ResourceActivityOperation {
  return { beforeCall: Promise.resolve(), finish: () => undefined };
}

describe('RuntimeControlClient', () => {
  beforeEach(() => constructed.splice(0));

  it('uses only the direct TCP port fetcher and never a waking path', async () => {
    const directFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const start = vi.fn();
    const containerFetch = vi.fn();
    const fetch = vi.fn();
    const startAndWaitForPorts = vi.fn();
    const ensureContainerRunning = vi.fn();
    const getTcpPort = vi.fn(() => ({ fetch: directFetch }));
    const runtimeClient = new RuntimeControlClient({
      getTcpPort,
      beginNonWakingOperation: noActivity
    });

    runtimeClient.get(id('runtime-a'));
    await constructed[0].options.stub.fetch(
      new Request('http://localhost/rpc')
    );

    expect(getTcpPort).toHaveBeenCalledWith(3000);
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(constructed[0].options.retryTimeoutMs).toBe(0);
    expect(constructed[0].options.onOperationStarted).toBe(noActivity);
    expect(constructed[0].options.translateTransportErrorsAsInterruptions).toBe(
      false
    );
    expect(start).not.toHaveBeenCalled();
    expect(containerFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(startAndWaitForPorts).not.toHaveBeenCalled();
    expect(ensureContainerRunning).not.toHaveBeenCalled();
  });

  it('disconnects runtime A before constructing runtime B', () => {
    const runtimeClient = new RuntimeControlClient({
      getTcpPort: () => ({ fetch: vi.fn() }),
      beginNonWakingOperation: noActivity
    });

    runtimeClient.get(id('runtime-a'));
    const first = constructed[0];
    runtimeClient.get(id('runtime-b'));

    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(constructed).toHaveLength(2);
  });

  it('permanently revokes a captured client before stale dispatch', async () => {
    const directFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const runtimeClient = new RuntimeControlClient({
      getTcpPort: () => ({ fetch: directFetch }),
      beginNonWakingOperation: noActivity
    });

    runtimeClient.get(id('runtime-a'));
    const captured = constructed[0];
    let resume!: () => void;
    const delayed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const staleOperation = (async () => {
      await delayed;
      captured.options.onDispatch?.();
      return captured.options.stub.fetch(new Request('http://localhost/rpc'));
    })();

    runtimeClient.get(id('runtime-b'));
    resume();

    await expect(staleOperation).rejects.toThrow();
    expect(directFetch).not.toHaveBeenCalled();
    expect(() => constructed[1].options.onDispatch?.()).not.toThrow();
    await constructed[1].options.stub.fetch(
      new Request('http://localhost/rpc')
    );
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it('translates direct port acquisition failures', async () => {
    const runtimeClient = new RuntimeControlClient({
      getTcpPort: () => {
        throw new Error('direct port unavailable');
      },
      beginNonWakingOperation: noActivity
    });

    expect(() => runtimeClient.get(id('runtime-a'))).toThrowError(
      expect.objectContaining({ name: 'RPCTransportError' })
    );
  });

  it('drops a direct client when its connection closes', () => {
    const runtimeClient = new RuntimeControlClient({
      getTcpPort: () => ({ fetch: vi.fn() }),
      beginNonWakingOperation: noActivity
    });

    runtimeClient.get(id('runtime-a'));
    constructed[0].options.onConnectionClose?.();
    runtimeClient.get(id('runtime-a'));

    expect(constructed).toHaveLength(2);
  });
});
