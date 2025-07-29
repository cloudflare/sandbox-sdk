/**
 * Setup file for container layer tests
 * 
 * This runs before each container test suite to set up the testing environment
 * for testing the refactored container services and handlers.
 */

import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Store original global state to restore after tests
let originalBun: any;

// Global test setup
beforeAll(async () => {
  // Set up any global mocks or test utilities
  console.log('🧪 Setting up container test environment...');
  
  // Store original Bun global if it exists
  originalBun = (globalThis as any).Bun;
});

afterAll(async () => {
  // Clean up global resources
  console.log('🧹 Cleaning up container test environment...');
  
  // Restore original Bun global
  if (originalBun !== undefined) {
    (globalThis as any).Bun = originalBun;
  } else {
    delete (globalThis as any).Bun;
  }
});

beforeEach(() => {
  // Reset mocks before each test to prevent interference
  // But don't clear global.Bun - let individual test files manage their own Bun mocks
  vi.clearAllMocks();
});

afterEach(() => {
  // Clean up vitest mocks after each test
  vi.clearAllMocks();
  
  // Note: We don't clean up global.Bun here because:
  // 1. Individual test files need their Bun mocks to persist during their suite
  // 2. Each test file sets up its own Bun mock in beforeEach
  // 3. Global cleanup happens in afterAll
});