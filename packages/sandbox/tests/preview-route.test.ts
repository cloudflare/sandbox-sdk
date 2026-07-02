import { describe, expect, it } from 'vitest';
import { constructPreviewURL, parsePreviewRoute } from '../src/preview/route';

describe('preview route helpers', () => {
  it('parses preview URLs with hyphenated sandbox IDs', () => {
    const route = parsePreviewRoute(
      new URL('https://8080-test-sandbox-token123.example.com/api')
    );

    expect(route).toEqual({
      port: 8080,
      sandboxId: 'test-sandbox',
      token: 'token123'
    });
  });

  it('returns null for non-preview URLs', () => {
    expect(parsePreviewRoute(new URL('https://example.com/api'))).toBeNull();
    expect(
      parsePreviewRoute(new URL('https://3000-sandbox-token.example.com'))
    ).toBeNull();
  });

  it('constructs production preview URLs', () => {
    expect(
      constructPreviewURL({
        port: 8080,
        sandboxId: 'test-sandbox',
        effectiveId: 'test-sandbox',
        hostname: 'example.com',
        token: 'token123',
        normalizeId: false
      })
    ).toBe('https://8080-test-sandbox-token123.example.com/');
  });

  it('constructs localhost preview URLs over HTTP', () => {
    expect(
      constructPreviewURL({
        port: 8080,
        sandboxId: 'test-sandbox',
        effectiveId: 'test-sandbox',
        hostname: 'localhost:8787',
        token: 'token123',
        normalizeId: false
      })
    ).toBe('http://8080-test-sandbox-token123.localhost:8787/');
  });
});
