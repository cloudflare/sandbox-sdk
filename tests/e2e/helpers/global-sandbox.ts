/**
 * Per-File Sandbox Helper
 *
 * Each test file creates its own isolated sandbox via createTestSandbox().
 * No shared state between test files.
 */

import { randomUUID } from 'node:crypto';
import {
  isDurableObjectCodeUpdateReset,
  isPlatformTransientError
} from '../../../packages/sandbox/src/platform-errors';
import type { SandboxCommand } from '../../../packages/shared/src/process-types';
import { createSandboxId, createTestHeaders } from './test-fixtures';

export type SandboxType =
  | 'default'
  | 'python'
  | 'opencode'
  | 'standalone'
  | 'musl';

export interface TestSandbox {
  workerUrl: string;
  sandboxId: string;
  /** Sandbox image type used for routing. */
  type: SandboxType;
  /** Create headers with sandbox type. */
  headers: () => Record<string, string>;
  /** Generate a unique path for test isolation within this sandbox. */
  uniquePath: (prefix: string) => string;
}

export interface CreateTestSandboxOptions {
  /** Container image type. Defaults to 'default' (base image). */
  type?: SandboxType;
  /** Command to run for initialization. Defaults to bash echo ready. */
  initCommand?: SandboxCommand;
  /** sleepAfter value applied to the sandbox for every request in this helper. */
  sleepAfter?: string | number;
}

interface SandboxInitFailureBody {
  code?: unknown;
  error?: unknown;
}

const SANDBOX_INIT_ATTEMPTS = 3;

function isRetryableSandboxInitFailure(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as SandboxInitFailureBody;
    return (
      parsed.code === 'CONTAINER_UNAVAILABLE' ||
      parsed.code === 'OPERATION_INTERRUPTED' ||
      isPlatformTransientError(parsed.error)
    );
  } catch {
    return isDurableObjectCodeUpdateReset(body);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an isolated sandbox for a test file.
 * Each call creates a new container instance.
 */
export async function createTestSandbox(
  options: CreateTestSandboxOptions = {}
): Promise<TestSandbox> {
  const {
    type = 'default',
    initCommand = ['/bin/bash', '-lc', 'echo ready'],
    sleepAfter
  } = options;
  const workerUrl = await getWorkerUrl();
  const sandboxId = createSandboxId();

  const makeHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      ...createTestHeaders(sandboxId)
    };
    if (type !== 'default') {
      h['X-Sandbox-Type'] = type;
    }
    if (sleepAfter !== undefined) {
      h['X-Sandbox-Sleep-After'] = String(sleepAfter);
    }
    return h;
  };

  for (let attempt = 1; attempt <= SANDBOX_INIT_ATTEMPTS; attempt += 1) {
    // Initialize the container with a side-effect-free command. The helper can
    // retry lifecycle interruptions here because `echo ready` is test-owned and
    // idempotent; tests that pass a mutating init command should handle their
    // own retry semantics.
    const initResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ command: initCommand }),
      signal: AbortSignal.timeout(60000)
    });

    if (initResponse.ok) break;

    const body = await initResponse.text().catch(() => '<unreadable>');
    if (
      initCommand[0] === '/bin/bash' &&
      initCommand[1] === '-lc' &&
      initCommand[2] === 'echo ready' &&
      initCommand.length === 3 &&
      attempt < SANDBOX_INIT_ATTEMPTS &&
      isRetryableSandboxInitFailure(body)
    ) {
      await delay(250 * attempt);
      continue;
    }

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
