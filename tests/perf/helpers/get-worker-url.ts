/**
 * Helper to get worker URL and env vars in perf tests
 *
 * Reads from the state file written by global-setup.ts.
 * Works in both local (wrangler dev) and CI (deployed worker) modes.
 *
 * Vitest worker threads cannot reliably read process.env, so all
 * env vars needed by tests are captured in global-setup and read here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { PERF_STATE_FILE } from '../global-setup';

interface PerfState {
  workerUrl: string;
  startTime: number;
  hasRunner: boolean;
  cloudflareAccountId: string;
  r2AccessKeyId: string;
}

let cachedState: PerfState | null = null;

function readState(): PerfState | null {
  if (cachedState) return cachedState;

  if (existsSync(PERF_STATE_FILE)) {
    try {
      cachedState = JSON.parse(
        readFileSync(PERF_STATE_FILE, 'utf-8')
      ) as PerfState;
      return cachedState;
    } catch (error) {
      console.error('[PerfTest] Failed to read state file:', error);
    }
  }
  return null;
}

/**
 * Get the worker URL from global setup state
 */
export function getWorkerUrl(): string {
  const state = readState();
  if (state?.workerUrl) return state.workerUrl;

  // Fallback to environment variable (for direct test runs)
  if (process.env.TEST_WORKER_URL) return process.env.TEST_WORKER_URL;

  throw new Error(
    'Worker URL not found. Make sure global-setup.ts has run or TEST_WORKER_URL is set.'
  );
}

/**
 * Get env vars captured by global-setup.
 * Returns empty strings for vars not set.
 */
export function getPerfEnv(): {
  cloudflareAccountId: string;
  r2AccessKeyId: string;
} {
  const state = readState();
  return {
    cloudflareAccountId:
      state?.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID || '',
    r2AccessKeyId: state?.r2AccessKeyId || process.env.R2_ACCESS_KEY_ID || ''
  };
}
