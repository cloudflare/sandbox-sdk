import { readFileSync } from 'node:fs';
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
    {
      name: 'tgz-binary-loader',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.tgz')) return null;
        const base64 = readFileSync(id).toString('base64');
        return `const base64 = ${JSON.stringify(base64)};\nexport default Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));`;
      }
    },
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
