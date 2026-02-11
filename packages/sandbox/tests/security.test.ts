import { describe, expect, it } from 'vitest';
import {
  SecurityError,
  sanitizeSandboxId,
  validatePort
} from '../src/security';

describe('validatePort', () => {
  it('accepts valid user ports (1024-65535 except 3000)', () => {
    expect(validatePort(1024)).toBe(true); // first non-privileged
    expect(validatePort(8080)).toBe(true); // common
    expect(validatePort(8787)).toBe(true); // was incorrectly blocked - this is the bug fix
    expect(validatePort(65535)).toBe(true); // max
  });

  it('rejects port 3000 (sandbox control plane)', () => {
    expect(validatePort(3000)).toBe(false);
  });

  it('rejects privileged ports (< 1024)', () => {
    expect(validatePort(0)).toBe(false);
    expect(validatePort(80)).toBe(false);
    expect(validatePort(1023)).toBe(false); // boundary
  });

  it('rejects out-of-range ports', () => {
    expect(validatePort(-1)).toBe(false);
    expect(validatePort(65536)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(validatePort(3000.5)).toBe(false);
    expect(validatePort(NaN)).toBe(false);
    expect(validatePort(Infinity)).toBe(false);
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
