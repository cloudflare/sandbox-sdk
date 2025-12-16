/**
 * Helper to get worker URL in perf tests
 *
 * Reads the worker URL from the state file written by global-setup.ts.
 * Works in both local (wrangler dev) and CI (deployed worker) modes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { PERF_STATE_FILE } from '../global-setup';

let cachedWorkerUrl: string | null = null;

/**
 * Get the worker URL from global setup state
 */
export function getWorkerUrl(): string {
  // Return cached URL if already loaded
  if (cachedWorkerUrl) {
    return cachedWorkerUrl;
  }

  // Read from state file (written by global-setup.ts)
  if (existsSync(PERF_STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(PERF_STATE_FILE, 'utf-8'));
      if (state.workerUrl) {
        cachedWorkerUrl = state.workerUrl as string;
        return cachedWorkerUrl;
      }
    } catch (error) {
      console.error('[PerfTest] Failed to read state file:', error);
    }
  }

  // Fallback to environment variable (for direct test runs)
  if (process.env.TEST_WORKER_URL) {
    cachedWorkerUrl = process.env.TEST_WORKER_URL;
    return cachedWorkerUrl;
  }

  throw new Error(
    'Worker URL not found. Make sure global-setup.ts has run or TEST_WORKER_URL is set.'
  );
}
