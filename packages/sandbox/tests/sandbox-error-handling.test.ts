import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';

// Mock dependencies before imports
vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const MockContainer = class Container {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(): Promise<Response> {
      return new Response('Mock Container fetch');
    }
    async containerFetch(): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }
    async getState() {
      // Return unhealthy so containerFetch() enters the startup path
      return { status: 'unhealthy' };
    }
    async startAndWaitForPorts() {
      // Will be spied on in tests
    }
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: vi.fn()
  };
});

/**
 * Tests for Sandbox.containerFetch() error classification logic.
 *
 * The containerFetch() method classifies errors from the container layer into:
 * - 503 (Service Unavailable) + Retry-After: 10: Container VM still provisioning
 * - 500 (Internal Server Error): Known permanent errors (OOM, bad image, etc.)
 * - 503 (Service Unavailable) + Retry-After: 3: Known transient errors (port not ready, etc.)
 * - 503 (Service Unavailable) + Retry-After: 5: Unrecognized errors (safe to retry)
 *
 * This test suite verifies that real error messages from workerd,
 * @cloudflare/containers, and the container runtime are correctly classified.
 *
 * Error sources:
 * - workerd/src/workerd/server/container-client.c++ (port mapping, monitor, image errors)
 * - @cloudflare/containers/src/lib/container.ts (startup, listening errors)
 * - Container runtime (OOM, PID limit)
 * - Scheduling/provisioning layer (no app, no namespace)
 */
describe('Sandbox.containerFetch() error classification', () => {
  let sandbox: Sandbox;
  let mockCtx: Partial<DurableObjectState<{}>>;
  let mockEnv: any;
  let startAndWaitSpy: ReturnType<typeof vi.spyOn>;

  // All 11 transient patterns from sandbox.ts isTransientStartupError()
  // Each pattern maps to a real error source
  const TRANSIENT_PATTERNS = [
    // From workerd container-client.c++ line 144
    'container port not found',
    'connection refused: container port',

    // From @cloudflare/containers container.ts lines 26, 479, 990
    'the container is not listening',
    'failed to verify port',
    'container did not start',

    // From @cloudflare/containers container.ts lines 717-718
    'network connection lost',
    'container suddenly disconnected',

    // From workerd container-client.c++ line 417
    'monitor failed to find container',

    // Generic timeout patterns (various layers)
    'timed out',
    'timeout',
    'the operation was aborted'
  ];

  // Known permanent errors that will never recover on retry
  // These return 500 with no Retry-After (fail fast)
  const PERMANENT_PATTERNS = [
    // Resource exhaustion (container runtime)
    'container crashed because it ran out of memory',
    'container crashed because it spawned too many subprocesses',

    // Misconfiguration (scheduling/provisioning)
    'there is no application that matches the provided constraints',
    'there is no container application assigned to this Durable Object namespace',

    // Missing image (workerd container-client.c++)
    'No such image available named myapp:latest',

    // User error (@cloudflare/containers)
    'durable object container did not call start'
  ];

  // Unrecognized errors that don't match any transient or permanent pattern
  // These return 503 with Retry-After: 5 (safe to retry since retries are idempotent)
  const UNRECOGNIZED_ERRORS = [
    'container already exists',
    'permission denied: cannot access docker socket',
    'invalid container configuration',
    'unknown error occurred'
  ];

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock DurableObjectState
    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map())
      } as any,
      blockConcurrencyWhile: vi
        .fn()
        .mockImplementation(
          <T>(callback: () => Promise<T>): Promise<T> => callback()
        ),
      waitUntil: vi.fn(),
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox'
      } as any
    };

    mockEnv = {};

    // Create Sandbox instance
    sandbox = new Sandbox(
      mockCtx as unknown as ConstructorParameters<typeof Sandbox>[0],
      mockEnv
    );

    // Wait for blockConcurrencyWhile to complete
    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    // Spy on startAndWaitForPorts - this is what throws errors during startup
    startAndWaitSpy = vi.spyOn(sandbox as any, 'startAndWaitForPorts');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to trigger containerFetch with a specific error
   */
  async function triggerContainerFetchWithError(
    errorMessage: string
  ): Promise<Response> {
    startAndWaitSpy.mockRejectedValueOnce(new Error(errorMessage));
    return sandbox.containerFetch(
      new Request('http://localhost/test'),
      {},
      8671
    );
  }

  describe('transient errors → 503 (should retry)', () => {
    it('returns 503 for "container port not found" (workerd container-client.c++:144)', async () => {
      const response = await triggerContainerFetchWithError(
        'connect(): Connection refused: container port not found. Make sure you exposed the port.'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
      const body = (await response.json()) as {
        code: string;
        message: string;
        context: { phase: string };
      };
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.message).toBe(
        'Container is starting. Please retry in a moment.'
      );
      expect(body.context.phase).toBe('startup');
    });

    it('returns 503 for "the container is not listening" (@cloudflare/containers)', async () => {
      const response = await triggerContainerFetchWithError(
        'the container is not listening on port 8671'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
    });

    it('returns 503 for "Monitor failed to find container" (workerd container-client.c++:417)', async () => {
      const response = await triggerContainerFetchWithError(
        'Monitor failed to find container'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
    });

    it('returns 503 for "failed to verify port" (@cloudflare/containers)', async () => {
      const response = await triggerContainerFetchWithError(
        'Failed to verify port 8671 is available after 20000ms'
      );

      expect(response.status).toBe(503);
    });

    it('returns 503 for timeout errors', async () => {
      const response = await triggerContainerFetchWithError(
        'Operation timed out after 30000ms'
      );

      expect(response.status).toBe(503);
    });

    // Parameterized test for comprehensive coverage of all patterns
    it.each(TRANSIENT_PATTERNS)(
      'returns 503 for pattern: "%s"',
      async (pattern) => {
        // Embed pattern in a realistic error message
        const errorMessage = `Error during startup: ${pattern} - please retry`;
        const response = await triggerContainerFetchWithError(errorMessage);

        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBeDefined();
      }
    );
  });

  describe('no instance error → 503 with provisioning message', () => {
    it('returns 503 with provisioning message for "no container instance"', async () => {
      const response = await triggerContainerFetchWithError(
        'there is no container instance that can be provided to this durable object'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('10');
      expect(
        ((await response.json()) as { context: { phase: string } }).context
          .phase
      ).toBe('provisioning');
    });

    it('returns 503 for case-insensitive "No Container Instance" match', async () => {
      const response = await triggerContainerFetchWithError(
        'Error: There is No Container Instance available at this time'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('10');
    });
  });

  describe('permanent errors → 500 (fail fast, no retry)', () => {
    it('returns 500 for OOM error (container runtime)', async () => {
      const response = await triggerContainerFetchWithError(
        'container crashed because it ran out of memory'
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
      const body = (await response.json()) as {
        code: string;
        message: string;
        context: { phase: string };
      };
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.message).toContain('permanent error');
      expect(body.context.phase).toBe('startup');
    });

    it('returns 500 for "no such image" errors (workerd)', async () => {
      const response = await triggerContainerFetchWithError(
        'No such image available named myapp:latest'
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
    });

    it('returns 500 for PID limit error (container runtime)', async () => {
      const response = await triggerContainerFetchWithError(
        'container crashed because it spawned too many subprocesses'
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
    });

    it('returns 500 for misconfiguration error (scheduling layer)', async () => {
      const response = await triggerContainerFetchWithError(
        'there is no application that matches the provided constraints'
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
    });

    // Parameterized test for comprehensive coverage of all permanent patterns
    it.each(PERMANENT_PATTERNS)(
      'returns 500 for permanent error: "%s"',
      async (errorMessage) => {
        const response = await triggerContainerFetchWithError(errorMessage);

        expect(response.status).toBe(500);
        expect(response.headers.get('Retry-After')).toBeNull();
      }
    );

    it('returns 500 when permanent cause is wrapped in transient message', async () => {
      // Platform can wrap permanent causes like "No such image" inside the generic
      // "container did not start" message. Permanent must be checked before transient
      // so the specific cause wins over the broad wrapper.
      const response = await triggerContainerFetchWithError(
        'container did not start: No such image available named myapp:v999'
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
      const body = (await response.json()) as { context: { error: string } };
      expect(body.context.error).toContain('No such image');
    });
  });
  describe('unrecognized errors → 503 (safe to retry)', () => {
    it('returns 503 for max instances exceeded (recoverable capacity limit)', async () => {
      // Confirmed via platform source: TOOMANYDURABLEOBJECTS resets the retry timer
      // and adds 10s backoff, expecting the condition to clear as load drops.
      // Lands in unrecognized tier (Retry-After: 5) since the message doesn't
      // match a known transient pattern, but still gets 503 for safe retry.
      const response = await triggerContainerFetchWithError(
        'maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('5');
    });

    it('returns 503 for "container already exists" errors (workerd)', async () => {
      const response = await triggerContainerFetchWithError(
        'Container already exists with name sandbox-123'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('5');
    });

    it('returns 503 for permission errors', async () => {
      const response = await triggerContainerFetchWithError(
        'permission denied: cannot access /var/run/docker.sock'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('5');
    });

    it('returns 503 for unknown/unrecognized errors', async () => {
      const response = await triggerContainerFetchWithError(
        'Something completely unexpected happened'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('5');
    });

    // Parameterized test for unrecognized errors
    it.each(UNRECOGNIZED_ERRORS)(
      'returns 503 for unrecognized error: "%s"',
      async (errorMessage) => {
        const response = await triggerContainerFetchWithError(errorMessage);

        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('5');
      }
    );
  });

  describe('response format', () => {
    it('503 responses include Retry-After: 3 for transient errors', async () => {
      const response = await triggerContainerFetchWithError(
        'container port not found'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
    });

    it('503 responses include Retry-After: 10 for provisioning errors', async () => {
      const response = await triggerContainerFetchWithError(
        'no container instance available'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('10');
    });

    it('503 responses for unrecognized errors include Retry-After: 5', async () => {
      const originalError = 'Docker daemon is not running';
      const response = await triggerContainerFetchWithError(originalError);

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('5');
    });

    it('500 responses for permanent errors have no Retry-After', async () => {
      const response = await triggerContainerFetchWithError(
        'container crashed because it ran out of memory'
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
    });

    it('503 responses for unrecognized errors include retry message in body', async () => {
      const response = await triggerContainerFetchWithError(
        'some new platform error'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('5');
      expect(
        ((await response.json()) as { message: string }).message
      ).toContain('Container is starting');
    });

    it('500 responses for permanent errors include configuration message in body', async () => {
      const response = await triggerContainerFetchWithError(
        'No such image available named myapp:v999'
      );

      expect(response.status).toBe(500);
      expect(
        ((await response.json()) as { message: string }).message
      ).toContain('permanent error');
    });
  });

  describe('healthy container bypasses error classification', () => {
    it('does not enter error path when container is already healthy', async () => {
      // Override getState to return healthy
      vi.spyOn(sandbox as any, 'getState').mockResolvedValueOnce({
        status: 'healthy'
      });

      // Mock parent containerFetch to return success
      const parentContainerFetch = vi
        .spyOn(
          Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
          'containerFetch'
        )
        .mockResolvedValueOnce(new Response('OK from container'));

      const response = await sandbox.containerFetch(
        new Request('http://localhost/test'),
        {},
        8671
      );

      // startAndWaitForPorts should NOT be called when healthy
      expect(startAndWaitSpy).not.toHaveBeenCalled();
      expect(response.status).toBe(200);

      parentContainerFetch.mockRestore();
    });
  });

  describe('stale persisted state recovery', () => {
    it('triggers startup with Sandbox timeouts when state is healthy but container is not running', async () => {
      vi.spyOn(sandbox as any, 'getState').mockResolvedValueOnce({
        status: 'healthy'
      });
      (sandbox as any).ctx.container = { running: false };
      startAndWaitSpy.mockResolvedValueOnce(undefined);

      const parentContainerFetch = vi
        .spyOn(
          Object.getPrototypeOf(Object.getPrototypeOf(sandbox)),
          'containerFetch'
        )
        .mockResolvedValueOnce(new Response('OK'));

      const response = await sandbox.containerFetch(
        new Request('http://localhost/test'),
        {},
        8671
      );

      expect(startAndWaitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          cancellationOptions: expect.objectContaining({
            instanceGetTimeoutMS: 30_000,
            portReadyTimeoutMS: 90_000
          })
        })
      );
      expect(response.status).toBe(200);
      parentContainerFetch.mockRestore();
    });

    it('aborts DO when startup fails after stale state detection', async () => {
      vi.spyOn(sandbox as any, 'getState').mockResolvedValueOnce({
        status: 'healthy'
      });
      (sandbox as any).ctx.container = { running: false };
      const abortSpy = vi.fn();
      (sandbox as any).ctx.abort = abortSpy;
      startAndWaitSpy.mockRejectedValueOnce(
        new Error('container port not found')
      );

      const response = await sandbox.containerFetch(
        new Request('http://localhost/test'),
        {},
        8671
      );

      expect(abortSpy).toHaveBeenCalled();
      expect(response.status).toBe(503);
    });

    it('does not abort DO on transient startup error without stale state', async () => {
      // State is unhealthy (not stale — container correctly knows it is down)
      vi.spyOn(sandbox as any, 'getState').mockResolvedValueOnce({
        status: 'unhealthy'
      });
      const abortSpy = vi.fn();
      (sandbox as any).ctx.abort = abortSpy;
      startAndWaitSpy.mockRejectedValueOnce(
        new Error('container port not found')
      );

      const response = await sandbox.containerFetch(
        new Request('http://localhost/test'),
        {},
        8671
      );

      expect(abortSpy).not.toHaveBeenCalled();
      expect(response.status).toBe(503);
    });
  });
});
