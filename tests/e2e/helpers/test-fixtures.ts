import { randomBytes } from 'node:crypto';

/**
 * Generate unique sandbox ID for test isolation
 *
 * Sandbox ID determines which container instance (Durable Object) to use.
 *
 * Usage patterns:
 * - **Different sandboxes**: Each test uses its own sandbox for complete isolation
 * - **Same sandbox**: Multiple operations in one test share a sandbox to test state persistence
 */
export function createSandboxId(): string {
  // Generate a short readable id with unique suffix e.g. sandbox-ebdm
  const id = randomBytes(4).toString('hex');
  return process.env.TEST_SANDBOX_ID
    ? `${process.env.TEST_SANDBOX_ID}-${id}`
    : `sandbox-${id}`;
}

/**
 * Create headers for sandbox identification.
 *
 * @param sandboxId - Which container instance to use
 */
export function createTestHeaders(sandboxId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Sandbox-Id': sandboxId
  };
}

/**
 * Create headers for Python image sandbox (with Python)
 *
 * Use this for testing the full image variant that includes Python.
 * The Python image is larger but supports Python code execution.
 *
 * @param sandboxId - Which container instance to use
 */
export function createPythonImageHeaders(
  sandboxId: string
): Record<string, string> {
  return {
    ...createTestHeaders(sandboxId),
    'X-Sandbox-Type': 'python'
  };
}

/**
 * Fetch with timeout to prevent hanging tests
 *
 * Usage:
 * ```typescript
 * const res = await fetchOrTimeout(
 *   fetch('http://example.com'),
 *   5000
 * );
 * ```
 */
export async function fetchOrTimeout(
  fetchPromise: Promise<Response>,
  timeoutMs: number
): Promise<Response> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  );

  return await Promise.race([fetchPromise, timeoutPromise]);
}

/**
 * Wait for condition with retries
 *
 * Note: Prefer using Vitest's built-in vi.waitFor() over this helper:
 * ```typescript
 * import { vi } from 'vitest';
 *
 * const response = await vi.waitFor(
 *   async () => {
 *     const res = await fetch(url);
 *     if (res.status !== 200) throw new Error('Not ready');
 *     return res;
 *   },
 *   { timeout: 10000 }
 * );
 * ```
 *
 * This helper is provided for cases where vi.waitFor() isn't suitable.
 */
export async function waitForCondition<T>(
  condition: () => Promise<T>,
  options: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
  } = {}
): Promise<T> {
  const timeout = options.timeout || 10000;
  const interval = options.interval || 500;
  const errorMessage =
    options.errorMessage || 'Condition not met within timeout';

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      return await condition();
    } catch (error) {
      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  throw new Error(errorMessage);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cleanup a sandbox instance by calling its destroy() RPC method
 *
 * This destroys the container and triggers the onStop() lifecycle hook.
 * Use in afterEach to ensure containers are cleaned up after each test.
 *
 * @param workerUrl - The base URL of the test worker
 * @param sandboxId - The sandbox ID to cleanup
 *
 * @example
 * ```typescript
 * afterEach(async () => {
 *   if (sandboxId) {
 *     await cleanupSandbox(workerUrl, sandboxId);
 *   }
 * });
 * ```
 */
export async function cleanupSandbox(
  workerUrl: string,
  sandboxId: string
): Promise<void> {
  try {
    const headers = createTestHeaders(sandboxId);

    // Call the cleanup RPC method via a special endpoint
    const response = await fetch(`${workerUrl}/cleanup`, {
      method: 'POST',
      headers
    });

    if (!response.ok) {
      console.warn(
        `Failed to cleanup sandbox ${sandboxId}: ${response.status}`
      );
    } else {
      console.log(`Cleaned up sandbox: ${sandboxId}`);
    }
  } catch (error) {
    // Don't fail tests if cleanup fails
    console.warn(`Error cleaning up sandbox ${sandboxId}:`, error);
  }
}
