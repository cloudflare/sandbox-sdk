import { describe, expect, it, vi } from 'vitest';
import { ContainerControlClient } from '../src/container-control/client';
import { ContainerUnavailableError } from '../src/errors';

/**
 * End-to-end RPC-path coverage for platform container-admission failures.
 *
 * Unlike rpc-sandbox-client.test.ts (which mocks ContainerControlConnection)
 * and container-connection.test.ts (which drives the connection directly),
 * these tests wire up the *real* stack:
 *
 *   ContainerControlClient
 *     → real ContainerControlConnection (real capnweb RpcSession + DeferredTransport)
 *       → stub.fetch() that reproduces the platform failure
 *
 * The stub throws the same message the Containers runtime raises when it can't
 * admit a container ("There is no container instance..."). The test asserts the
 * caller of a queued RPC method (`utils.createSession`) receives a typed
 * ContainerUnavailableError — not a masked OPERATION_INTERRUPTED / generic
 * capnweb disposal error.
 *
 * These run in workerd via vitest-pool-workers, so the RpcSession, transport,
 * and error propagation are exercised for real.
 */
describe('RPC path: platform container-admission failures', () => {
  const PLATFORM_MESSAGE =
    'There is no container instance that can be provided to this Durable Object, try again later';

  function makeClient(fetchImpl: (req: Request) => Promise<Response>) {
    return new ContainerControlClient({
      stub: { fetch: fetchImpl },
      port: 3000,
      // Disable the upgrade retry budget so the test fails fast on the first
      // attempt instead of waiting out exponential backoff.
      retryTimeoutMs: 0
    });
  }

  it('surfaces ContainerUnavailableError to a queued RPC caller when the platform throws a real Error', async () => {
    const client = makeClient(() =>
      Promise.reject(new Error(PLATFORM_MESSAGE))
    );

    let thrown: unknown;
    try {
      await client.utils.createSession({ id: 'test', cwd: '/' });
    } catch (e) {
      thrown = e;
    } finally {
      client.disconnect();
    }

    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    const err = thrown as ContainerUnavailableError;
    expect(err.code).toBe('CONTAINER_UNAVAILABLE');
    expect(err.reason).toBe('no_container_instance_available');
    expect(err.context.retryable).toBe(true);
    expect(err.context.originalMessage).toContain(
      'no container instance that can be provided'
    );
  });

  it('detects the failure even when the thrown value is a cross-realm-style plain object (no instanceof Error)', async () => {
    // Simulate an error raised in another realm: `instanceof Error` is false
    // but it still carries a `message`. This is the exact case the previous
    // `instanceof Error` gate silently dropped.
    const crossRealm = { name: 'Error', message: PLATFORM_MESSAGE };
    const client = makeClient(() => Promise.reject(crossRealm));

    let thrown: unknown;
    try {
      await client.utils.createSession({ id: 'test', cwd: '/' });
    } catch (e) {
      thrown = e;
    } finally {
      client.disconnect();
    }

    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    expect((thrown as ContainerUnavailableError).reason).toBe(
      'no_container_instance_available'
    );
  });

  it('detects the failure regardless of message casing', async () => {
    const upper = new Error(PLATFORM_MESSAGE.toUpperCase());
    const client = makeClient(() => Promise.reject(upper));

    let thrown: unknown;
    try {
      await client.utils.createSession({ id: 'test', cwd: '/' });
    } catch (e) {
      thrown = e;
    } finally {
      client.disconnect();
    }

    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    expect((thrown as ContainerUnavailableError).reason).toBe(
      'no_container_instance_available'
    );
  });

  it('classifies the "max instances exceeded" platform message', async () => {
    const message =
      'Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances';
    const client = makeClient(() => Promise.reject(new Error(message)));

    let thrown: unknown;
    try {
      await client.utils.createSession({ id: 'test', cwd: '/' });
    } catch (e) {
      thrown = e;
    } finally {
      client.disconnect();
    }

    expect(thrown).toBeInstanceOf(ContainerUnavailableError);
    expect((thrown as ContainerUnavailableError).reason).toBe(
      'max_container_instances_exceeded'
    );
  });

  it('retries the thrown platform error within the budget, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const ws = {
        addEventListener: () => {},
        removeEventListener: () => {},
        send: () => {},
        close: () => {},
        accept: () => {}
      } as unknown as WebSocket;
      const upgrade = {
        status: 101,
        statusText: 'Switching Protocols',
        webSocket: ws
      } as unknown as Response;

      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockRejectedValueOnce(new Error(PLATFORM_MESSAGE))
        .mockResolvedValueOnce(upgrade);

      const client = new ContainerControlClient({
        stub: { fetch: fetchMock },
        port: 3000,
        retryTimeoutMs: 60_000
      });

      // Kick the connection; don't await the RPC (it would hang waiting for a
      // real capnweb response over our fake WS). We only assert the upgrade
      // was retried past the first thrown platform error.
      void client.connect().catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});
