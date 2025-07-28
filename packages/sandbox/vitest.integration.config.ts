import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    
    // Only run integration tests that need Workers runtime
    include: ['src/__tests__/integration/**/*.test.ts'],
    
    poolOptions: {
      workers: {
        // Simplified wrangler config for testing
        wrangler: {
          configPath: './wrangler.toml',
        },
        
        miniflare: {
          isolatedStorage: true,
          
          // Durable Objects configuration
          durableObjects: {
            'Sandbox': 'Sandbox',
          },
          
          // Test bindings
          kvNamespaces: ['TEST_KV'],
          r2Buckets: ['TEST_R2'], 
          d1Databases: ['DB'],
        },
        
        main: './src/index.ts',
      },
    },
    
    testTimeout: 30000, // Longer timeout for Cloudflare operations
    maxConcurrency: 3, // Lower concurrency for integration tests
  },
  
  esbuild: {
    target: 'esnext',
  },
});