import { describe, expect, it } from 'vitest';
import {
  readPreviewProxyMetadata,
  withPreviewProxyMetadata
} from '../src/preview/protocol';

describe('preview proxy protocol helpers', () => {
  it('writes preview proxy metadata and strips stale internal headers', () => {
    const request = new Request('https://8080-sandbox-token.example.com/path', {
      headers: {
        'x-sandbox-preview-proxy': '0',
        'x-sandbox-preview-port': '9000',
        'x-sandbox-preview-token': 'stale',
        'x-sandbox-preview-sandbox-id': 'stale-sandbox',
        'x-custom-header': 'preserved'
      }
    });

    const forwarded = withPreviewProxyMetadata(request, {
      port: 8080,
      token: 'token',
      sandboxId: 'sandbox'
    });

    expect(forwarded.headers.get('x-sandbox-preview-proxy')).toBe('1');
    expect(forwarded.headers.get('x-sandbox-preview-port')).toBe('8080');
    expect(forwarded.headers.get('x-sandbox-preview-token')).toBe('token');
    expect(forwarded.headers.get('x-sandbox-preview-sandbox-id')).toBe(
      'sandbox'
    );
    expect(forwarded.headers.get('x-custom-header')).toBe('preserved');
  });

  it('reads valid preview proxy metadata', () => {
    const request = withPreviewProxyMetadata(
      new Request('https://example.com/path'),
      {
        port: 8080,
        token: 'token',
        sandboxId: 'sandbox'
      }
    );

    expect(readPreviewProxyMetadata(request)).toEqual({
      port: 8080,
      token: 'token',
      sandboxId: 'sandbox'
    });
  });

  it('rejects missing and invalid preview proxy metadata', () => {
    expect(readPreviewProxyMetadata(new Request('https://example.com'))).toBe(
      null
    );

    const invalidPort = new Request('https://example.com', {
      headers: {
        'x-sandbox-preview-proxy': '1',
        'x-sandbox-preview-port': '3000',
        'x-sandbox-preview-token': 'token',
        'x-sandbox-preview-sandbox-id': 'sandbox'
      }
    });

    expect(readPreviewProxyMetadata(invalidPort)).toBe(null);
  });
});
