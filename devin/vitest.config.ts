import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true
  },
  resolve: {
    alias: {
      'cloudflare:workers': new URL(
        './test/mocks/cloudflare-workers.ts',
        import.meta.url
      ).pathname
    }
  }
});
