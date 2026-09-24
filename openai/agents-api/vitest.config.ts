import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc'
      },
      miniflare: {
        compatibilityDate: '2026-06-24',
        bindings: {
          OPENAI_EXECUTOR_API_KEY: 'executor-key',
          EXECUTOR_CLIENT_SECRET: 'executor-client-secret',
          OPENAI_API_KEY: 'controller-key',
          OPENAI_AGENT_ID: 'agent_1',
          OPENAI_WEBHOOK_SECRET: 'webhook-secret'
        }
      }
    })
  ],
  test: {
    include: ['test/**/*.workers.test.ts'],
    restoreMocks: true
  }
});
