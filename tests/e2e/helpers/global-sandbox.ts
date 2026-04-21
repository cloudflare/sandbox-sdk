/**
 * Per-File Sandbox Helper
 *
 * Each test file creates its own isolated sandbox via createTestSandbox().
 * No shared state between test files.
 */

import { randomUUID } from 'node:crypto';
import {
  createSandboxId,
  createTestHeaders,
  fetchWithRetry
} from './test-fixtures';

export type SandboxType =
  | 'default'
  | 'python'
  | 'opencode'
  | 'standalone'
  | 'musl'
  | 'desktop';

export interface TestSandbox {
  workerUrl: string;
  sandboxId: string;
  /** Sandbox image type used for routing. */
  type: SandboxType;
  /** Create headers with optional session ID. Includes sandbox type. */
  headers: (sessionId?: string) => Record<string, string>;
  /** Generate a unique path for test isolation within this sandbox. */
  uniquePath: (prefix: string) => string;
}

export interface CreateTestSandboxOptions {
  /** Container image type. Defaults to 'default' (base image). */
  type?: SandboxType;
  /** Command to run for initialization. Defaults to 'echo ready'. */
  initCommand?: string;
  /** sleepAfter value applied to the sandbox for every request in this helper. */
  sleepAfter?: string | number;
}

/**
 * Create an isolated sandbox for a test file.
 * Each call creates a new container instance.
 */
export async function createTestSandbox(
  options: CreateTestSandboxOptions = {}
): Promise<TestSandbox> {
  const { type = 'default', initCommand = 'true', sleepAfter = '1m' } = options;
  const workerUrl = await getWorkerUrl();
  const sandboxId = createSandboxId();

  const makeHeaders = (sessionId?: string): Record<string, string> => {
    return {
      ...createTestHeaders(sandboxId, sessionId),
      // This is required on every request for correct routing.
      ...(type !== 'default' ? { 'X-Sandbox-Type': type } : {})
    };
  };

  // Initialize the container — retried because the container may still be booting
  const initResponse = await fetchWithRetry(
    () =>
      fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: makeHeaders(),
        body: JSON.stringify({ command: initCommand }),
        signal: AbortSignal.timeout(30_000)
      }),
    { retries: 3, delayMs: 1000 }
  );

  if (!initResponse.ok) {
    const body = await initResponse.text().catch(() => '<unreadable>');
    throw new Error(
      `Failed to initialize ${type} sandbox: ${initResponse.status} - ${body}`
    );
  }

  if (sleepAfter !== undefined) {
    const sleepAfterHeaders = makeHeaders();
    sleepAfterHeaders['X-Sandbox-Sleep-After'] = String(sleepAfter);

    // Configure sleep-after once the container has booted.
    const sleepAfterResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: sleepAfterHeaders,
      body: JSON.stringify({ command: initCommand }),
      signal: AbortSignal.timeout(5000)
    });

    if (!sleepAfterResponse.ok) {
      const body = await sleepAfterResponse.text().catch(() => '<unreadable>');
      throw new Error(
        `Failed to set sleep after: ${sleepAfterResponse.status} - ${body}`
      );
    }
  }

  return {
    workerUrl,
    sandboxId,
    type,
    headers: makeHeaders,
    uniquePath: (prefix: string) =>
      `/workspace/test-${randomUUID().slice(0, 8)}/${prefix}`
  };
}

/** Teardown timeout — fail fast so hanging cleanup doesn't block the suite. */
const CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Clean up a sandbox created by createTestSandbox().
 * Safe to call with null (no-op). Uses a short timeout so hangs are logged quickly.
 */
export async function cleanupTestSandbox(
  sandbox: TestSandbox | null
): Promise<void> {
  if (!sandbox) return;
  try {
    const response = await fetch(`${sandbox.workerUrl}/cleanup`, {
      method: 'POST',
      headers: sandbox.headers(),
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    });
    if (!response.ok) {
      console.warn({
        message: 'cleanupTestSandbox: non-OK response',
        sandboxId: sandbox.sandboxId,
        status: response.status
      });
    } else {
      console.log({
        message: 'cleanupTestSandbox: success',
        sandboxId: sandbox.sandboxId
      });
    }
  } catch (error) {
    console.warn({
      message: 'cleanupTestSandbox: request failed (teardown continuing)',
      sandboxId: sandbox.sandboxId,
      error
    });
  }
}

/**
 * Create a unique session ID for test isolation within a sandbox.
 */
export function createUniqueSession(): string {
  return `session-${randomUUID()}`;
}

// -- Internal --

async function getWorkerUrl(): Promise<string> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const stateFile = join(tmpdir(), 'e2e-global-state.json');

  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (state.workerUrl) return state.workerUrl;
    } catch {
      // Fall through
    }
  }

  // Fallback: get URL directly (single-thread mode / no global setup)
  const { getTestWorkerUrl } = await import('./wrangler-runner');
  const result = await getTestWorkerUrl();
  return result.url;
}
