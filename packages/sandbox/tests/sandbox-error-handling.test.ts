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
 * - 503 (Service Unavailable): Transient errors that should trigger client retry
 * - 500 (Internal Server Error): Permanent errors that should NOT be retried
 *
 * This test suite verifies that real error messages from workerd and
 * @cloudflare/containers are correctly classified.
 *
 * Error sources:
 * - workerd/src/workerd/server/container-client.c++ (port mapping, monitor errors)
 * - @cloudflare/containers/src/lib/container.ts (startup, listening errors)
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

  // Permanent errors that should NOT match transient patterns
  // These come from workerd container-client.c++ lines 307-309
  const PERMANENT_ERRORS = [
    'no such image available named myimage',
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
      3000
    );
  }

  describe('transient errors → 503 (should retry)', () => {
    it('returns 503 for "container port not found" (workerd container-client.c++:144)', async () => {
      const response = await triggerContainerFetchWithError(
        'connect(): Connection refused: container port not found. Make sure you exposed the port.'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
      expect(await response.text()).toBe(
        'Container is starting. Please retry in a moment.'
      );
    });

    it('returns 503 for "the container is not listening" (@cloudflare/containers)', async () => {
      const response = await triggerContainerFetchWithError(
        'the container is not listening on port 3000'
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
        'Failed to verify port 3000 is available after 20000ms'
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
      expect(await response.text()).toContain('provisioning');
    });

    it('returns 503 for case-insensitive "No Container Instance" match', async () => {
      const response = await triggerContainerFetchWithError(
        'Error: There is No Container Instance available at this time'
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('10');
    });
  });

  describe('permanent errors → 500 (should not retry)', () => {
    it('returns 500 for "no such image" errors (workerd)', async () => {
      const response = await triggerContainerFetchWithError(
        'No such image available named myapp:latest'
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
      const body = await response.text();
      expect(body).toContain('Failed to start container');
      expect(body).toContain('No such image');
    });

    it('returns 500 for "container already exists" errors (workerd)', async () => {
      const response = await triggerContainerFetchWithError(
        'Container already exists with name sandbox-123'
      );

      expect(response.status).toBe(500);
    });

    it('returns 500 for permission errors', async () => {
      const response = await triggerContainerFetchWithError(
        'permission denied: cannot access /var/run/docker.sock'
      );

      expect(response.status).toBe(500);
    });

    it('returns 500 for unknown/unrecognized errors', async () => {
      const response = await triggerContainerFetchWithError(
        'Something completely unexpected happened'
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toContain('Failed to start container');
    });

    // Parameterized test for permanent errors
    it.each(PERMANENT_ERRORS)(
      'returns 500 for permanent error: "%s"',
      async (errorMessage) => {
        const response = await triggerContainerFetchWithError(errorMessage);

        expect(response.status).toBe(500);
        expect(response.headers.get('Retry-After')).toBeNull();
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

    it('500 responses include original error message in body', async () => {
      const originalError = 'Docker daemon is not running';
      const response = await triggerContainerFetchWithError(originalError);

      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain(originalError);
    });

    it('500 responses do not include Retry-After header', async () => {
      const response =
        await triggerContainerFetchWithError('permanent failure');

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeNull();
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
        3000
      );

      // startAndWaitForPorts should NOT be called when healthy
      expect(startAndWaitSpy).not.toHaveBeenCalled();
      expect(response.status).toBe(200);

      parentContainerFetch.mockRestore();
    });
  });
});
