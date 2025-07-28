import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    
    // Include all integration tests that work without containers
    include: [
      'src/__tests__/integration/basic-*.test.ts',
      'src/__tests__/integration/client-architecture-*.test.ts'
    ],
    
    poolOptions: {
      workers: {
        main: './src/index.ts',
        
        // Don't use wrangler config for now to avoid container issues
        // wrangler: {
        //   configPath: './wrangler.toml',
        // },
        
        miniflare: {
          compatibilityDate: '2025-05-06',
          compatibilityFlags: ['nodejs_compat'],
          
          // Basic Durable Objects configuration 
          durableObjects: {
            'Sandbox': 'Sandbox',
          },
          
          // Test bindings
          kvNamespaces: ['TEST_KV'],
        },
      },
    },
    
    testTimeout: 30000,
    maxConcurrency: 1,
  },
  
  esbuild: {
    target: 'esnext',
  },
});