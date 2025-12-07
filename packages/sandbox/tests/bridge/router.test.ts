import { describe, expect, it } from 'vitest';
import { parseRoute } from '../../src/bridge/router';

describe('parseRoute', () => {
  it('should parse sandbox ID and path from URL', () => {
    const url = new URL('https://example.com/api/sandbox/my-sandbox/exec');
    const result = parseRoute(url);

    expect(result).toEqual({
      sandboxId: 'my-sandbox',
      path: '/exec',
      segments: ['exec']
    });
  });

  it('should handle nested paths', () => {
    const url = new URL(
      'https://example.com/api/sandbox/test-123/processes/abc/logs'
    );
    const result = parseRoute(url);

    expect(result).toEqual({
      sandboxId: 'test-123',
      path: '/processes/abc/logs',
      segments: ['processes', 'abc', 'logs']
    });
  });

  it('should return null for non-API paths', () => {
    const url = new URL('https://example.com/health');
    const result = parseRoute(url);

    expect(result).toBeNull();
  });

  it('should return null for malformed API paths', () => {
    const url = new URL('https://example.com/api/sandbox');
    const result = parseRoute(url);

    expect(result).toBeNull();
  });
});
