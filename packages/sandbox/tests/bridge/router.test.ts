import { describe, expect, it } from 'vitest';
import {
  addCorsHeaders,
  handleCors,
  parseRoute
} from '../../src/bridge/router';

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

describe('handleCors', () => {
  it('should return 204 with CORS headers for OPTIONS request', () => {
    const response = handleCors();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, POST, PUT, DELETE, OPTIONS'
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type, Authorization'
    );
  });
});

describe('addCorsHeaders', () => {
  it('should add CORS headers to existing response', () => {
    const original = new Response('test', { status: 200 });
    const withCors = addCorsHeaders(original);

    expect(withCors.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
