import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ['tests-harness/**/*.test.ts'],
    testTimeout: 180_000
  }
});
