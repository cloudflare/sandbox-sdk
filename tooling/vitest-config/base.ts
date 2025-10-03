import type { UserConfig } from 'vitest/config';

/**
 * Base test configuration shared across all packages
 */
export const baseTestConfig: UserConfig['test'] = {
  globals: true,
  environment: 'node',
  testTimeout: 10000,
  hookTimeout: 10000,
  teardownTimeout: 10000,
  isolate: true,
  pool: 'forks',
  poolOptions: {
    forks: {
      singleFork: false,
    },
  },
};

/**
 * Create a test configuration for unit tests
 */
export function createUnitTestConfig(options?: {
  include?: string[];
  coverage?: NonNullable<UserConfig['test']>['coverage'];
}): UserConfig['test'] {
  return {
    ...baseTestConfig,
    include: options?.include || ['src/__tests__/unit/**/*.test.ts'],
    coverage: options?.coverage,
  };
}

/**
 * Create a test configuration for integration tests
 */
export function createIntegrationTestConfig(options?: {
  include?: string[];
  name?: string;
}): UserConfig['test'] {
  return {
    ...baseTestConfig,
    name: options?.name || 'integration-tests',
    include: options?.include || ['__tests__/integration/**/*.test.ts'],
  };
}

/**
 * Create a test configuration for container tests
 */
export function createContainerTestConfig(options?: {
  include?: string[];
  setupFiles?: string[];
}): UserConfig['test'] {
  return {
    ...baseTestConfig,
    name: 'container-tests',
    include: options?.include || ['src/__tests__/**/*.test.ts'],
    setupFiles: options?.setupFiles,
  };
}
