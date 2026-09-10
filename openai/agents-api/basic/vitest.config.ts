import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityDate: '2026-06-24',
        bindings: {
          OPENAI_API_KEY: 'application-key',
          OPENAI_AGENT_ID: 'agent_1',
          EXECUTOR_URL: 'https://executor.example.test',
          EXECUTOR_CLIENT_SECRET: 'cleanup-secret'
        }
      }
    })
  ],
  test: {
    include: ['test/**/*.workers.test.ts'],
    restoreMocks: true
  }
});
