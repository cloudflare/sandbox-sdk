/**
 * Per-File Sandbox Helper
 *
 * Each test file creates its own isolated sandbox via createTestSandbox().
 * No shared state between test files.
 */

import { randomUUID } from 'node:crypto';
import { createSandboxId, createTestHeaders } from './test-fixtures';

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
  const { type = 'default', initCommand = 'echo ready', sleepAfter } = options;
  const workerUrl = await getWorkerUrl();
  const sandboxId = createSandboxId();

  const makeHeaders = (sessionId?: string): Record<string, string> => {
    const h: Record<string, string> = {
      ...createTestHeaders(sandboxId, sessionId)
    };
    if (type !== 'default') {
      h['X-Sandbox-Type'] = type;
    }
    if (sleepAfter !== undefined) {
      h['X-Sandbox-Sleep-After'] = String(sleepAfter);
    }
    return h;
  };

  // Initialize the container with a simple command
  const initResponse = await fetch(`${workerUrl}/api/execute`, {
    method: 'POST',
    headers: makeHeaders(),
    body: JSON.stringify({ command: initCommand })
  });

  if (!initResponse.ok) {
    const body = await initResponse.text().catch(() => '<unreadable>');
    throw new Error(
      `Failed to initialize ${type} sandbox: ${initResponse.status} - ${body}`
    );
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

/**
 * Clean up a sandbox created by createTestSandbox().
 * Safe to call with null (no-op).
 */
export async function cleanupTestSandbox(
  sandbox: TestSandbox | null
): Promise<void> {
  if (!sandbox) return;
  try {
    const response = await fetch(`${sandbox.workerUrl}/cleanup`, {
      method: 'POST',
      headers: sandbox.headers(),
      signal: AbortSignal.timeout(1000)
    });
    if (!response.ok) {
      console.warn(
        `Failed to cleanup sandbox ${sandbox.sandboxId}: ${response.status}`
      );
    } else {
      console.log(`Cleaned up sandbox: ${sandbox.sandboxId}`);
    }
  } catch (error) {
    console.warn(`Error cleaning up sandbox ${sandbox.sandboxId}:`, error);
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
