import { DEFAULT_CONTROL_PORT } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validatePort } from '../src/security';

describe('Configurable control port', () => {
  describe('validatePort with custom control port', () => {
    it('rejects the default control port', () => {
      expect(validatePort(DEFAULT_CONTROL_PORT, DEFAULT_CONTROL_PORT)).toBe(
        false
      );
    });

    it('rejects a custom control port', () => {
      expect(validatePort(9500, 9500)).toBe(false);
    });

    it('accepts port 3000 when control port is the default', () => {
      expect(validatePort(3000, DEFAULT_CONTROL_PORT)).toBe(true);
    });

    it('accepts the default port when a different control port is specified', () => {
      expect(validatePort(DEFAULT_CONTROL_PORT, 9500)).toBe(true);
    });

    it('still rejects privileged ports regardless of control port', () => {
      expect(validatePort(80, 9500)).toBe(false);
      expect(validatePort(443, 9500)).toBe(false);
    });

    it('still rejects out-of-range ports regardless of control port', () => {
      expect(validatePort(65536, 9500)).toBe(false);
      expect(validatePort(-1, 9500)).toBe(false);
    });
  });

  describe('DEFAULT_CONTROL_PORT', () => {
    it('is 8671', () => {
      expect(DEFAULT_CONTROL_PORT).toBe(8671);
    });
  });
});
