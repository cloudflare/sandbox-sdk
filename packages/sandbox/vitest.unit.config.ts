import { defineConfig } from 'vitest/config';
import { createUnitTestConfig } from '@repo/vitest-config';

export default defineConfig({
  test: {
    ...createUnitTestConfig({
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'lcov', 'json'],

        include: [
          'src/**/*.{ts,js}',
        ],

        exclude: [
          'node_modules/**',
          'dist/**',
          '**/*.test.ts',
          '**/__tests__/**',
          '**/__mocks__/**',
          '**/*.d.ts',
          'container_src/**', // Container tested separately
          '**/types.ts',
        ],

        // Coverage thresholds for unit tests
        thresholds: {
          lines: 90,
          functions: 85,
          branches: 85,
          statements: 90,
          perFile: true,
        },

        clean: true,
        cleanOnRerun: true,
      },
    }),
    maxConcurrency: 5,
  },

  esbuild: {
    target: 'esnext',
  },
});