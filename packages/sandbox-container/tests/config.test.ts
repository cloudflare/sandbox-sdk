import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONTROL_PORT } from '@repo/shared';
import { CONFIG } from '@sandbox-container/config';

describe('CONFIG.SERVER_PORT', () => {
  test('uses DEFAULT_CONTROL_PORT when SANDBOX_CONTROL_PORT is not set', () => {
    expect(CONFIG.SERVER_PORT).toBe(DEFAULT_CONTROL_PORT);
  });

  test('is a valid port number', () => {
    expect(CONFIG.SERVER_PORT).toBeGreaterThanOrEqual(1);
    expect(CONFIG.SERVER_PORT).toBeLessThanOrEqual(65535);
    expect(Number.isInteger(CONFIG.SERVER_PORT)).toBe(true);
  });
});
