import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Workers runtime test configuration
 *
 * Tests the SDK code in Cloudflare Workers environment with Durable Objects.
 * Uses @cloudflare/vitest-pool-workers to run tests in workerd runtime.
 *
 * Run with: npm test
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './tests/wrangler.jsonc'
      }
    })
  ],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 10000
  },
  esbuild: {
    target: 'esnext'
  }
});
