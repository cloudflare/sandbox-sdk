import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true
  },
  resolve: {
    alias: {
      'cloudflare:workers': new URL(
        './tests/mocks/cloudflare-workers.ts',
        import.meta.url
      ).pathname
    }
  }
});
