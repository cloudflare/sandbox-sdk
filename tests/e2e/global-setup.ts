import { getTestWorkerUrl } from './helpers/wrangler-runner';

/**
 * Global setup for E2E tests
 *
 * Runs ONCE before all test files to start a single wrangler dev instance.
 * This enables parallel test execution by sharing one wrangler process.
 *
 * The worker URL is shared via process.env.TEST_WORKER_URL_GLOBAL_SETUP
 * Returns a teardown function that vitest will call to stop wrangler
 */
export default async function setup() {
  console.log('\n🚀 [Global Setup] Starting wrangler dev for all E2E tests...\n');

  // Check if we're using a deployed worker (CI mode)
  if (process.env.TEST_WORKER_URL) {
    console.log(`[Global Setup] Using deployed worker: ${process.env.TEST_WORKER_URL}`);
    console.log('[Global Setup] No local wrangler needed\n');
    // Return empty teardown function for CI mode
    return () => {};
  }

  // Local mode: Start ONE wrangler dev for all tests
  const { url, runner } = await getTestWorkerUrl();

  // Share URL with all test files via environment variable
  process.env.TEST_WORKER_URL_GLOBAL_SETUP = url;

  console.log(`\n✅ [Global Setup] Wrangler dev ready at: ${url}\n`);
  console.log('[Global Setup] All test files will share this instance for parallel execution\n');

  // Return teardown function to stop wrangler
  return async () => {
    console.log('\n🧹 [Global Teardown] Stopping wrangler dev...\n');
    if (runner) {
      await runner.stop();
      console.log('✅ [Global Teardown] Wrangler dev stopped\n');
    }
  };
}
