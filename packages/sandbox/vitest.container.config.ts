import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    include: [
      'src/__tests__/container/**/*.test.ts',
    ],
    
    // Global setup runs in Node.js and can build containers
    globalSetup: ['./global-setup.ts'],
    
    poolOptions: {
      workers: ({ inject }) => {
        const buildId = inject('containerBuildId');
        
        return {
          main: './src/index.ts',
          
          // Use wrangler config for full container support with dynamic build ID
          wrangler: {
            configPath: './wrangler.jsonc',
            containerBuildId: buildId,
          },
        
          // Override for testing
          miniflare: {
            bindings: {
              NODE_ENV: 'test',
              // Container build info available to tests (with fallbacks)
              CONTAINER_BUILD_ID: buildId || 'not-available',
              CONTAINER_READY: inject('containerReady') || false,
            }
          },
        };
      },
    },
    
    // Container tests need more time and resources
    testTimeout: 60000,
    maxConcurrency: 1,
    isolatedStorage: false, // Disable isolated storage for container tests due to persistent issues
  },
  
  esbuild: {
    target: 'esnext',
  },
});