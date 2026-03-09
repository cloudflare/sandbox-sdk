import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const baseURL = process.env.TEST_WORKER_URL || 'http://localhost:8787';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? 'github' : 'list',
  timeout: 60000,

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],

  webServer: process.env.TEST_WORKER_URL
    ? undefined
    : {
        // --inspector-port 0 disables inspector to avoid wrangler hanging during startup
        command: 'npx wrangler dev --inspector-port 0',
        cwd: '../test-worker',
        url: 'http://localhost:8787/health',
        reuseExistingServer: !isCI,
        timeout: 300000
      }
});
