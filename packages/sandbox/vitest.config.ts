import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Workers runtime test configuration
 *
 * Tests the SDK code in Cloudflare Workers environment with Durable Objects.
 * Uses @cloudflare/vitest-pool-workers to run tests in workerd runtime.
 *
 * Run with: npm test
 */
export default defineWorkersConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 10000,
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './tests/wrangler.jsonc'
        },
        singleWorker: true,
        isolatedStorage: false
      }
    }
  },
  esbuild: {
    target: 'esnext'
  }
});
