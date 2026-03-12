import { DEFAULT_CONTROL_PORT } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  SecurityError,
  sanitizeSandboxId,
  validatePort
} from '../src/security';

const CONTROL_PORT = DEFAULT_CONTROL_PORT;

describe('validatePort', () => {
  it('accepts valid user ports (1024-65535 except control port)', () => {
    expect(validatePort(1024, CONTROL_PORT)).toBe(true);
    expect(validatePort(3000, CONTROL_PORT)).toBe(true);
    expect(validatePort(8080, CONTROL_PORT)).toBe(true);
    expect(validatePort(8787, CONTROL_PORT)).toBe(true);
    expect(validatePort(65535, CONTROL_PORT)).toBe(true);
  });

  it('rejects the control port', () => {
    expect(validatePort(CONTROL_PORT, CONTROL_PORT)).toBe(false);
  });

  it('rejects privileged ports (< 1024)', () => {
    expect(validatePort(0, CONTROL_PORT)).toBe(false);
    expect(validatePort(80, CONTROL_PORT)).toBe(false);
    expect(validatePort(1023, CONTROL_PORT)).toBe(false);
  });

  it('rejects out-of-range ports', () => {
    expect(validatePort(-1, CONTROL_PORT)).toBe(false);
    expect(validatePort(65536, CONTROL_PORT)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(validatePort(8080.5, CONTROL_PORT)).toBe(false);
    expect(validatePort(NaN, CONTROL_PORT)).toBe(false);
    expect(validatePort(Infinity, CONTROL_PORT)).toBe(false);
  });

  describe('with custom control port', () => {
    it('rejects the custom control port', () => {
      expect(validatePort(9500, 9500)).toBe(false);
    });

    it('accepts the default port when a different control port is specified', () => {
      expect(validatePort(DEFAULT_CONTROL_PORT, 9500)).toBe(true);
    });

    it('still rejects privileged and out-of-range ports', () => {
      expect(validatePort(80, 9500)).toBe(false);
      expect(validatePort(65536, 9500)).toBe(false);
    });
  });
});

describe('sanitizeSandboxId', () => {
  it('accepts valid DNS-compliant IDs', () => {
    expect(sanitizeSandboxId('myproject')).toBe('myproject');
    expect(sanitizeSandboxId('my-project')).toBe('my-project');
    expect(sanitizeSandboxId('abc-123-def-456')).toBe('abc-123-def-456');
    expect(sanitizeSandboxId('a'.repeat(63))).toBe('a'.repeat(63)); // max length
  });

  it('rejects invalid lengths', () => {
    expect(() => sanitizeSandboxId('')).toThrow(SecurityError);
    expect(() => sanitizeSandboxId('a'.repeat(64))).toThrow(SecurityError);
  });

  it('rejects leading/trailing hyphens (DNS requirement)', () => {
    expect(() => sanitizeSandboxId('-myproject')).toThrow(SecurityError);
    expect(() => sanitizeSandboxId('myproject-')).toThrow(SecurityError);
  });

  it('rejects reserved names case-insensitively', () => {
    expect(() => sanitizeSandboxId('www')).toThrow(SecurityError);
    expect(() => sanitizeSandboxId('API')).toThrow(SecurityError);
  });
});
