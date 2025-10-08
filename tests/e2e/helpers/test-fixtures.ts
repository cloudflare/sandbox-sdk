import { randomUUID } from 'node:crypto';

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
  return randomUUID();
}

/**
 * Generate unique session ID for session isolation testing
 *
 * Session ID determines which shell session within a container to use.
 * Most tests should NOT need this - the SDK handles default sessions automatically.
 *
 * Only use this for:
 * - Testing session isolation (multiple sessions in one sandbox)
 * - Testing session-specific environment variables
 */
export function createSessionId(): string {
  return `session-${randomUUID()}`;
}

/**
 * Create headers for sandbox/session identification
 *
 * @param sandboxId - Which container instance to use
 * @param sessionId - (Optional) Which session within that container (SDK defaults to auto-managed session)
 *
 * @example
 * // Most tests: unique sandbox, default session
 * const headers = createTestHeaders(createSandboxId());
 *
 * @example
 * // Session isolation tests: one sandbox, multiple sessions
 * const sandboxId = createSandboxId();
 * const headers1 = createTestHeaders(sandboxId, createSessionId());
 * const headers2 = createTestHeaders(sandboxId, createSessionId());
 */
export function createTestHeaders(sandboxId: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Sandbox-Id': sandboxId,
  };

  if (sessionId) {
    headers['X-Session-Id'] = sessionId;
  }

  return headers;
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
  const errorMessage = options.errorMessage || 'Condition not met within timeout';

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      return await condition();
    } catch (error) {
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  throw new Error(errorMessage);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
