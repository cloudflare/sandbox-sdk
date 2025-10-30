import type { Mock } from 'bun:test';

/**
 * Helper to get properly typed mock functions.
 */
export const mocked = <T extends (...args: any[]) => any>(fn: T) =>
  fn as unknown as Mock<T>;
