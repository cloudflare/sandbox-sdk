import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Workers runtime test configuration
 *
 * Tests the SDK code in Cloudflare Workers environment with Durable Objects.
 * Uses @cloudflare/vitest-pool-workers to run tests in workerd runtime.
 *
 * Run with: npm test
 *
 * Compatibility flags are fixed per workerd isolate at startup, so a single
 * isolate cannot toggle `enable_abortsignal_rpc` mid-run. To exercise both
 * sides of issue #764, the AbortSignal regression test runs under two extra
 * projects that boot the pool with different compatibility flags. The
 * `ABORTSIGNAL_RPC_ENABLED` binding tells that test which mode it is running
 * under so it can assert the matching behaviour.
 */
const baseWrangler = {
  configPath: './tests/wrangler.jsonc'
} as const;

const abortSignalTest = 'tests/abortsignal-rpc.test.ts';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 10000,
    // The issue #764 flag-off project intentionally triggers a
    // DataCloneError for the AbortSignal. workerd's RPC layer rejects an
    // internal promise with that error in addition to the one the test
    // awaits, and that internal rejection is unreachable from test code.
    // Drop only that specific error so the deliberate repro doesn't fail the
    // run; every other unhandled error still does.
    onUnhandledError(error) {
      const isAbortSignalCloneError =
        error.name === 'DataCloneError' &&
        /AbortSignal serialization is not enabled/i.test(error.message ?? '');
      if (isAbortSignalCloneError) return false;
    },
    projects: [
      {
        // Main suite. Keeps strict unhandled-error checking; the AbortSignal
        // regression file is exercised by the two dedicated projects below.
        plugins: [cloudflareTest({ wrangler: baseWrangler })],
        test: {
          name: 'sandbox',
          globals: true,
          include: ['tests/**/*.test.ts'],
          exclude: [abortSignalTest]
        },
        esbuild: { target: 'esnext' }
      },
      {
        // Issue #764, flag OFF: passing an AbortSignal must throw the
        // structured-clone error.
        plugins: [
          cloudflareTest({
            wrangler: baseWrangler,
            miniflare: {
              bindings: { ABORTSIGNAL_RPC_ENABLED: false }
            }
          })
        ],
        test: {
          name: 'sandbox-abortsignal-rpc-disabled',
          globals: true,
          include: [abortSignalTest]
        },
        esbuild: { target: 'esnext' }
      },
      {
        // Issue #764, flag ON: the AbortSignal serializes and the call gets
        // past the RPC boundary without a structured-clone error.
        plugins: [
          cloudflareTest({
            wrangler: baseWrangler,
            miniflare: {
              compatibilityFlags: ['enable_abortsignal_rpc'],
              bindings: { ABORTSIGNAL_RPC_ENABLED: true }
            }
          })
        ],
        test: {
          name: 'sandbox-abortsignal-rpc-enabled',
          globals: true,
          include: [abortSignalTest]
        },
        esbuild: { target: 'esnext' }
      }
    ]
  }
});
