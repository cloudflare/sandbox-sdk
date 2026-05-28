import { describe, expect, it } from 'vitest';
import {
  SandboxSecurityError,
  sanitizeSandboxId,
  validatePort,
  validateTunnelName
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
    expect(() => sanitizeSandboxId('')).toThrow(SandboxSecurityError);
    expect(() => sanitizeSandboxId('a'.repeat(64))).toThrow(
      SandboxSecurityError
    );
  });

  it('rejects leading/trailing hyphens (DNS requirement)', () => {
    expect(() => sanitizeSandboxId('-myproject')).toThrow(SandboxSecurityError);
    expect(() => sanitizeSandboxId('myproject-')).toThrow(SandboxSecurityError);
  });

  it('rejects reserved names case-insensitively', () => {
    expect(() => sanitizeSandboxId('www')).toThrow(SandboxSecurityError);
    expect(() => sanitizeSandboxId('API')).toThrow(SandboxSecurityError);
  });
});

describe('validateTunnelName', () => {
  it('accepts valid single DNS labels', () => {
    expect(() => validateTunnelName('api')).not.toThrow();
    expect(() => validateTunnelName('api-staging')).not.toThrow();
    expect(() => validateTunnelName('a')).not.toThrow();
    expect(() => validateTunnelName('123')).not.toThrow();
    expect(() => validateTunnelName('a1b2-c3d4')).not.toThrow();
    expect(() => validateTunnelName('a'.repeat(63))).not.toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => validateTunnelName('')).toThrow(SandboxSecurityError);
  });

  it('rejects names longer than 63 characters', () => {
    expect(() => validateTunnelName('a'.repeat(64))).toThrow(
      SandboxSecurityError
    );
  });

  it('rejects uppercase letters', () => {
    expect(() => validateTunnelName('Api')).toThrow(SandboxSecurityError);
    expect(() => validateTunnelName('API')).toThrow(SandboxSecurityError);
  });

  it('rejects leading or trailing hyphens', () => {
    expect(() => validateTunnelName('-api')).toThrow(SandboxSecurityError);
    expect(() => validateTunnelName('api-')).toThrow(SandboxSecurityError);
  });

  it('rejects multi-label names (dots are not allowed)', () => {
    expect(() => validateTunnelName('api.staging')).toThrow(
      SandboxSecurityError
    );
    expect(() => validateTunnelName('a.b.c')).toThrow(SandboxSecurityError);
  });

  it('rejects underscores and other non-DNS characters', () => {
    expect(() => validateTunnelName('api_staging')).toThrow(
      SandboxSecurityError
    );
    expect(() => validateTunnelName('api staging')).toThrow(
      SandboxSecurityError
    );
    expect(() => validateTunnelName('api/staging')).toThrow(
      SandboxSecurityError
    );
  });

  it('rejects non-string inputs', () => {
    // Defensive against caller errors slipping past TypeScript.
    expect(() => validateTunnelName(undefined as unknown as string)).toThrow(
      SandboxSecurityError
    );
    expect(() => validateTunnelName(null as unknown as string)).toThrow(
      SandboxSecurityError
    );
    expect(() => validateTunnelName(42 as unknown as string)).toThrow(
      SandboxSecurityError
    );
  });

  it('error message names the invalid input for debuggability', () => {
    try {
      validateTunnelName('Api.Staging');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxSecurityError);
      expect((err as Error).message).toContain('Api.Staging');
    }
  });
});
