import { defineConfig } from 'vitest/config';

/**
 * Standard vitest configuration for shared package
 *
 * Tests pure TypeScript utilities and types (logger, errors, etc.)
 * No Workers runtime needed - uses Node.js environment.
 *
 * Run with: npm test
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000
  },
  esbuild: {
    target: 'esnext'
  }
});
