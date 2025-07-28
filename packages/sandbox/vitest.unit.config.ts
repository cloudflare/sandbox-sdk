import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Global test configuration
    globals: true,
    
    // Use node environment for unit tests (faster execution)
    environment: 'node',
    
    // Only run unit tests
    include: ['src/__tests__/unit/**/*.test.ts'],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json'],
      
      include: [
        'src/**/*.{ts,js}',
      ],
      
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/__tests__/**',
        '**/__mocks__/**',
        '**/*.d.ts',
        'container_src/**', // Container tested separately
        '**/types.ts',
      ],
      
      // Coverage thresholds for unit tests
      thresholds: {
        lines: 90,
        functions: 85,
        branches: 85,
        statements: 90,
        perFile: true,
      },
      
      clean: true,
      cleanOnRerun: true,
    },
    
    testTimeout: 10000,
    maxConcurrency: 5,
  },
  
  esbuild: {
    target: 'esnext',
  },
});