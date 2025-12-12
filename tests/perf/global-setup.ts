/**
 * Global Setup for Performance Tests
 *
 * Runs once before any test scenarios.
 * Two modes:
 * 1. CI: Uses TEST_WORKER_URL pointing to deployed worker
 * 2. Local: Spawns wrangler dev automatically
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTestWorkerUrl,
  type WranglerDevRunner
} from '../e2e/helpers/wrangler-runner';
import { GlobalMetricsStore } from './helpers/metrics-collector';

export const PERF_STATE_FILE = join(tmpdir(), 'perf-test-state.json');
const TEST_WORKER_DIR = 'tests/e2e/test-worker';

let runner: WranglerDevRunner | null = null;

/**
 * Generate wrangler.jsonc from template if it doesn't exist
 */
function ensureWranglerConfig(): void {
  const configPath = join(TEST_WORKER_DIR, 'wrangler.jsonc');
  if (!existsSync(configPath)) {
    console.log('[PerfSetup] Generating wrangler.jsonc from template...');
    execSync('./generate-config.sh sandbox-perf-test-worker-local', {
      cwd: TEST_WORKER_DIR,
      stdio: 'inherit'
    });
  }
}

export async function setup() {
  console.log('\n[PerfSetup] Initializing performance test suite...');

  // Clean up stale state from crashed runs
  if (existsSync(PERF_STATE_FILE)) {
    unlinkSync(PERF_STATE_FILE);
  }

  // Ensure wrangler config exists for local mode
  if (!process.env.TEST_WORKER_URL) {
    ensureWranglerConfig();
  }

  // Get worker URL (spawns wrangler dev locally if TEST_WORKER_URL not set)
  const result = await getTestWorkerUrl();
  runner = result.runner;
  const workerUrl = result.url;

  // Verify worker is accessible
  try {
    const healthResponse = await fetch(`${workerUrl}/health`);
    if (!healthResponse.ok) {
      throw new Error(`Worker health check failed: ${healthResponse.status}`);
    }
    const body = (await healthResponse.json()) as { status: string };
    if (body.status !== 'ok') {
      throw new Error(
        `Worker health check returned unexpected status: ${body.status}`
      );
    }
    console.log(`[PerfSetup] Worker accessible at: ${workerUrl}`);
  } catch (error) {
    throw new Error(`Cannot connect to worker at ${workerUrl}: ${error}`);
  }

  // Initialize global metrics store
  const store = GlobalMetricsStore.getInstance();
  store.reset();
  store.setRunMetadata({
    workerUrl,
    startTime: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    mode: runner ? 'local' : 'ci'
  });

  // Create output directory
  const outputDir = './perf-results';
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Write state file for inter-process communication
  writeFileSync(
    PERF_STATE_FILE,
    JSON.stringify({
      workerUrl,
      startTime: Date.now(),
      hasRunner: !!runner
    })
  );

  console.log('[PerfSetup] Ready!\n');
}

export { runner };
