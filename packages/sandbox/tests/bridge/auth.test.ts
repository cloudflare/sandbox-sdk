import { describe, expect, it } from 'vitest';
import { AuthError, validateApiKey } from '../../src/bridge/auth';

describe('validateApiKey', () => {
  it('should return true for valid API key', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer test-api-key' }
    });

    expect(validateApiKey(request, 'test-api-key')).toBe(true);
  });

  it('should throw AuthError for missing Authorization header', () => {
    const request = new Request('https://example.com');

    expect(() => validateApiKey(request, 'test-api-key')).toThrow(AuthError);
  });

  it('should throw AuthError for invalid token format', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' }
    });

    expect(() => validateApiKey(request, 'test-api-key')).toThrow(AuthError);
  });

  it('should throw AuthError for wrong API key', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer wrong-key' }
    });

    expect(() => validateApiKey(request, 'test-api-key')).toThrow(AuthError);
  });
});
