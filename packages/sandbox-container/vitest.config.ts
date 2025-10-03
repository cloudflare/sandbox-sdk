import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { createContainerTestConfig } from '@repo/vitest-config';

export default defineConfig({
  test: createContainerTestConfig({
    setupFiles: ['src/__tests__/setup.ts'],
  }),
  resolve: {
    alias: {
      '@container': path.resolve(__dirname, 'src'),
    },
  },
});
