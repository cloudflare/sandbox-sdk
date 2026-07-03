import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

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
    include: [
      'tests/**/*.test.ts',
      // Extensions live under repo-root `extensions/` but are compiled as
      // subpaths of `@cloudflare/sandbox`, so their unit tests run against
      // this package's workerd runtime config.
      '../../extensions/*/tests/**/*.test.ts'
    ],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 10000
  },
  esbuild: {
    target: 'esnext'
  },
  resolve: {
    // Alias the public authoring subpaths so extension source files that
    // live outside `packages/sandbox/src/` can import
    // `@cloudflare/sandbox/extensions` / `/sidecar` / `/errors` without a
    // pre-existing `dist/`. Runtime resolution (in built consumers) still
    // goes through the package.json `exports` map.
    alias: {
      '@cloudflare/sandbox/extensions': resolve(
        here,
        'src/extensions/index.ts'
      ),
      '@cloudflare/sandbox/sidecar': resolve(here, 'src/sidecar/index.ts'),
      '@cloudflare/sandbox/errors': resolve(here, 'src/errors/index.ts')
    }
  }
});
