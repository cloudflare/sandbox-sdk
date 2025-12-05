/**
 * Global Setup for E2E Tests
 *
 * Runs ONCE before any test threads spawn.
 * Creates the shared sandbox and passes info via a temp file (env vars don't work across processes).
 */

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import {
  createSandboxId,
  createTestHeaders,
  createPythonImageHeaders,
  cleanupSandbox
} from './helpers/test-fixtures';

// Shared state file path
export const SHARED_STATE_FILE = join(tmpdir(), 'e2e-shared-sandbox.json');

let runner: WranglerDevRunner | null = null;
let sandboxId: string | null = null;
let workerUrl: string | null = null;

export async function setup() {
  console.log(
    '\n[GlobalSetup] Starting wrangler and creating shared sandbox...'
  );

  // Clean up stale state from crashed runs
  if (existsSync(SHARED_STATE_FILE)) {
    unlinkSync(SHARED_STATE_FILE);
  }

  const result = await getTestWorkerUrl();
  runner = result.runner;
  workerUrl = result.url;
  sandboxId = createSandboxId();

  // Initialize the sandboxes
  const headers = createTestHeaders(sandboxId);
  const initResponse = await fetch(`${workerUrl}/api/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: 'echo "Global sandbox initialized"' })
  });

  if (!initResponse.ok) {
    throw new Error(`Failed to initialize sandbox: ${initResponse.status}`);
  }

  const pythonHeaders = createPythonImageHeaders(sandboxId);
  const pythonInitResponse = await fetch(`${workerUrl}/api/execute`, {
    method: 'POST',
    headers: pythonHeaders,
    body: JSON.stringify({ command: 'echo "Python sandbox initialized"' })
  });

  if (!pythonInitResponse.ok) {
    console.warn(
      `Warning: Failed to initialize Python sandbox: ${pythonInitResponse.status}`
    );
  }

  // Write state to temp file for worker threads to read
  writeFileSync(SHARED_STATE_FILE, JSON.stringify({ workerUrl, sandboxId }));

  console.log(
    `[GlobalSetup] Ready! URL: ${workerUrl}, Sandbox: ${sandboxId}\n`
  );
}

export async function teardown() {
  console.log('\n[GlobalTeardown] Cleaning up...');

  if (sandboxId && workerUrl) {
    try {
      await cleanupSandbox(workerUrl, sandboxId);
    } catch (e) {
      console.warn('[GlobalTeardown] Cleanup error:', e);
    }
  }

  if (runner) {
    await runner.stop();
  }

  // Clean up state file
  if (existsSync(SHARED_STATE_FILE)) {
    unlinkSync(SHARED_STATE_FILE);
  }

  console.log('[GlobalTeardown] Done\n');
}
