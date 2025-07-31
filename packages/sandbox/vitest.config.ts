import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Global test configuration
    globals: true, // Enable global test APIs (describe, it, expect)
    
    // Use node environment for unit tests (faster than Workers runtime)
    environment: 'node',
    
    // Coverage configuration (V8 provider recommended)
    coverage: {
      provider: 'v8', // Fastest, native coverage
      reporter: ['text', 'html', 'lcov', 'json'],
      
      // Include patterns (Vitest 3.x pattern)
      include: [
        'src/**/*.{ts,js}',
      ],
      
      // Exclude patterns
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/__tests__/**',
        '**/__mocks__/**',
        '**/*.d.ts',
        'container_src/**', // Container has separate testing
        '**/types.ts',
      ],
      
      // Coverage thresholds
      thresholds: {
        lines: 90,
        functions: 85,
        branches: 85,
        statements: 90,
        // Per-file thresholds
        perFile: true,
      },
      
      // Clean coverage on rerun
      clean: true,
      cleanOnRerun: true,
    },
    
    // Test execution options
    maxConcurrency: 5,
    testTimeout: 10000, // 10s should be sufficient for unit tests
  },
  
  // ESBuild configuration
  esbuild: {
    target: 'esnext',
  },
});