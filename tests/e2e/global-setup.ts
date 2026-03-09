/**
 * Global Setup for E2E Tests
 *
 * Runs ONCE before any test threads spawn.
 * Resolves the worker URL and passes it via a temp file.
 * Does NOT create any sandboxes — each test file creates its own.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTestWorkerUrl,
  type WranglerDevRunner
} from './helpers/wrangler-runner';

export const SHARED_STATE_FILE = join(tmpdir(), 'e2e-global-state.json');

let runner: WranglerDevRunner | null = null;

export async function setup() {
  console.log('\n[GlobalSetup] Resolving worker URL...');

  if (existsSync(SHARED_STATE_FILE)) {
    unlinkSync(SHARED_STATE_FILE);
  }

  const result = await getTestWorkerUrl();
  runner = result.runner;

  writeFileSync(SHARED_STATE_FILE, JSON.stringify({ workerUrl: result.url }));
  console.log(`[GlobalSetup] Ready! URL: ${result.url}\n`);
}

export async function teardown() {
  console.log('\n[GlobalTeardown] Cleaning up...');

  if (runner) {
    await runner.stop();
  }

  if (existsSync(SHARED_STATE_FILE)) {
    unlinkSync(SHARED_STATE_FILE);
  }

  console.log('[GlobalTeardown] Done\n');
}
