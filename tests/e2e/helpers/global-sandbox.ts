/**
 * Global Sandbox Manager
 *
 * Provides a single shared sandbox for all e2e tests to dramatically reduce
 * container startup/shutdown overhead.
 *
 * Architecture:
 * - ONE sandbox (container) is created on first access
 * - Each test file gets a unique SESSION within that sandbox
 * - Sessions provide isolated shell environments (env, cwd, shell state)
 * - File system and process space are SHARED (tests must use unique paths)
 *
 * Usage in test files:
 * ```typescript
 * import { getSharedSandbox, createUniqueSession } from './helpers/global-sandbox';
 *
 * describe('My Tests', () => {
 *   let workerUrl: string;
 *   let headers: Record<string, string>;
 *
 *   beforeAll(async () => {
 *     const sandbox = await getSharedSandbox();
 *     workerUrl = sandbox.workerUrl;
 *     headers = sandbox.createHeaders(createUniqueSession());
 *   });
 *
 *   test('my test', async () => {
 *     const res = await fetch(`${workerUrl}/api/execute`, { headers, ... });
 *   });
 * });
 * ```
 */

import { randomUUID } from 'node:crypto';
import {
  cleanupSandbox,
  createSandboxId,
  createTestHeaders
} from './test-fixtures';
import { getTestWorkerUrl, type WranglerDevRunner } from './wrangler-runner';

export interface SharedSandbox {
  /** The worker URL to make requests to */
  workerUrl: string;
  /** The shared sandbox ID */
  sandboxId: string;
  /** Create headers for a specific session (base image) */
  createHeaders: (sessionId?: string) => Record<string, string>;
  /** Create headers for Python image sandbox (with Python) */
  createPythonHeaders: (sessionId?: string) => Record<string, string>;
  /** Create headers for OpenCode image sandbox (with OpenCode CLI) */
  createOpencodeHeaders: (sessionId?: string) => Record<string, string>;
  /** Create headers for standalone binary sandbox (arbitrary base image) */
  createStandaloneHeaders: (sessionId?: string) => Record<string, string>;
  /** Generate a unique file path prefix for test isolation */
  uniquePath: (prefix: string) => string;
}

// Singleton state - persists across test files in the same process
let sharedSandbox: SharedSandbox | null = null;
let runner: WranglerDevRunner | null = null;
let initPromise: Promise<SharedSandbox> | null = null;

/**
 * Get or create the shared sandbox.
 * First call initializes, subsequent calls return the same instance.
 * Thread-safe via promise caching.
 */
export async function getSharedSandbox(): Promise<SharedSandbox> {
  // Return existing sandbox
  if (sharedSandbox) {
    return sharedSandbox;
  }

  // If initialization in progress, wait for it
  if (initPromise) {
    return initPromise;
  }

  // Start initialization (only happens once)
  initPromise = initializeSharedSandbox();
  return initPromise;
}

/**
 * Create a unique session ID for test isolation.
 * Each test file should use a unique session.
 */
export function createUniqueSession(): string {
  return `session-${randomUUID()}`;
}

/**
 * Generate a unique file path for test isolation.
 * Use this to avoid file conflicts between tests.
 */
export function uniqueTestPath(prefix: string): string {
  return `/workspace/test-${randomUUID().slice(0, 8)}/${prefix}`;
}

async function initializeSharedSandbox(): Promise<SharedSandbox> {
  // Check if global setup already created the sandbox (read from temp file)
  const { readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const stateFile = join(tmpdir(), 'e2e-shared-sandbox.json');

  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (state.workerUrl && state.sandboxId) {
        console.log(
          `[SharedSandbox] Using global setup sandbox: ${state.sandboxId.slice(0, 12)}...`
        );
        const baseHeaders = createTestHeaders(state.sandboxId);

        sharedSandbox = {
          workerUrl: state.workerUrl,
          sandboxId: state.sandboxId,
          createHeaders: (sessionId?: string) => {
            const headers = { ...baseHeaders };
            if (sessionId) {
              headers['X-Session-Id'] = sessionId;
            }
            return headers;
          },
          createPythonHeaders: (sessionId?: string) => {
            const headers: Record<string, string> = {
              ...baseHeaders,
              'X-Sandbox-Type': 'python'
            };
            if (sessionId) {
              headers['X-Session-Id'] = sessionId;
            }
            return headers;
          },
          createOpencodeHeaders: (sessionId?: string) => {
            const headers: Record<string, string> = {
              ...baseHeaders,
              'X-Sandbox-Type': 'opencode'
            };
            if (sessionId) {
              headers['X-Session-Id'] = sessionId;
            }
            return headers;
          },
          createStandaloneHeaders: (sessionId?: string) => {
            const headers: Record<string, string> = {
              ...baseHeaders,
              'X-Sandbox-Type': 'standalone'
            };
            if (sessionId) {
              headers['X-Session-Id'] = sessionId;
            }
            return headers;
          },
          uniquePath: (prefix: string) =>
            `/workspace/test-${randomUUID().slice(0, 8)}/${prefix}`
        };
        return sharedSandbox;
      }
    } catch {
      console.warn(
        '[SharedSandbox] Failed to read state file, creating new sandbox'
      );
    }
  }

  // Fallback: create sandbox ourselves (single-threaded mode or no global setup)
  console.log('\n[SharedSandbox] Initializing (this only happens once)...');

  const result = await getTestWorkerUrl();
  runner = result.runner;

  const sandboxId = createSandboxId();
  const baseHeaders = createTestHeaders(sandboxId);

  // Initialize the sandbox with a simple command
  const initResponse = await fetch(`${result.url}/api/execute`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({ command: 'echo "Shared sandbox initialized"' })
  });

  if (!initResponse.ok) {
    throw new Error(
      `Failed to initialize shared sandbox: ${initResponse.status}`
    );
  }

  console.log(`[SharedSandbox] Ready! ID: ${sandboxId}\n`);

  sharedSandbox = {
    workerUrl: result.url,
    sandboxId,
    createHeaders: (sessionId?: string) => {
      const headers = { ...baseHeaders };
      if (sessionId) {
        headers['X-Session-Id'] = sessionId;
      }
      return headers;
    },
    createPythonHeaders: (sessionId?: string) => {
      const headers: Record<string, string> = {
        ...baseHeaders,
        'X-Sandbox-Type': 'python'
      };
      if (sessionId) {
        headers['X-Session-Id'] = sessionId;
      }
      return headers;
    },
    createOpencodeHeaders: (sessionId?: string) => {
      const headers: Record<string, string> = {
        ...baseHeaders,
        'X-Sandbox-Type': 'opencode'
      };
      if (sessionId) {
        headers['X-Session-Id'] = sessionId;
      }
      return headers;
    },
    createStandaloneHeaders: (sessionId?: string) => {
      const headers: Record<string, string> = {
        ...baseHeaders,
        'X-Sandbox-Type': 'standalone'
      };
      if (sessionId) {
        headers['X-Session-Id'] = sessionId;
      }
      return headers;
    },
    uniquePath: (prefix: string) =>
      `/workspace/test-${randomUUID().slice(0, 8)}/${prefix}`
  };

  // Register cleanup on process exit (only when we created it)
  process.on('beforeExit', async () => {
    await cleanupSharedSandbox();
  });

  // Handle SIGTERM/SIGINT for graceful shutdown (e.g., Ctrl+C, CI termination)
  const handleSignal = async (signal: string) => {
    console.log(`\n[SharedSandbox] Received ${signal}, cleaning up...`);
    await cleanupSharedSandbox();
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  return sharedSandbox;
}

async function cleanupSharedSandbox(): Promise<void> {
  if (!sharedSandbox) return;

  console.log('\n[SharedSandbox] Cleaning up...');

  try {
    await cleanupSandbox(sharedSandbox.workerUrl, sharedSandbox.sandboxId);
  } catch (error) {
    console.warn('[SharedSandbox] Cleanup error:', error);
  }

  if (runner) {
    await runner.stop();
    runner = null;
  }

  sharedSandbox = null;
  initPromise = null;
  console.log('[SharedSandbox] Cleanup complete\n');
}

/**
 * Force cleanup - can be called manually if needed
 */
export async function forceCleanupSharedSandbox(): Promise<void> {
  await cleanupSharedSandbox();
}
