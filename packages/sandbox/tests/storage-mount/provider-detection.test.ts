import { describe, expect, it } from 'vitest';
import {
  detectProviderFromUrl,
  getProviderFlags,
  resolveS3fsOptions
} from '../../src/storage-mount/provider-detection';

describe('Provider Detection', () => {
  describe('detectProviderFromUrl', () => {
    it.each([
      ['https://abc123.r2.cloudflarestorage.com', 'r2'],
      ['https://s3.us-west-2.amazonaws.com', 's3'],
      ['https://storage.googleapis.com', 'gcs'],
      ['http://minio.local:9000', 'minio'],
      ['https://s3.us-west-001.backblazeb2.com', 'backblaze'],
      ['https://s3.wasabisys.com', 'wasabi'],
      ['https://nyc3.digitaloceanspaces.com', 'digitalocean']
    ])('should detect %s as %s', (url, expectedProvider) => {
      expect(detectProviderFromUrl(url)).toBe(expectedProvider);
    });

    it.each([['https://custom.storage.example.com'], ['not-a-url'], ['']])(
      'should return null for unknown/invalid: %s',
      (url) => {
        expect(detectProviderFromUrl(url)).toBe(null);
      }
    );
  });

  describe('getProviderFlags', () => {
    it.each([
      ['r2', ['nomixupload', 'endpoint=auto']],
      ['s3', []],
      ['gcs', []],
      ['minio', ['use_path_request_style']],
      ['backblaze', []],
      ['wasabi', []],
      ['digitalocean', []],
      ['custom', []]
    ])('should return correct flags for %s', (provider, expected) => {
      expect(getProviderFlags(provider as any)).toEqual(expected);
    });

    it('should return safe defaults for unknown providers', () => {
      expect(getProviderFlags(null)).toEqual(['use_path_request_style']);
    });
  });

  describe('resolveS3fsOptions', () => {
    it('should use provider defaults when no user options', () => {
      const options = resolveS3fsOptions('r2');
      expect(options).toEqual(['nomixupload', 'endpoint=auto']);
    });

    it('should merge provider flags with user options', () => {
      const options = resolveS3fsOptions('r2', ['custom_flag']);
      expect(options).toContain('nomixupload');
      expect(options).toContain('endpoint=auto');
      expect(options).toContain('custom_flag');
    });

    it('should allow user options to override provider defaults', () => {
      const options = resolveS3fsOptions('r2', ['endpoint=us-east']);
      expect(options).toContain('nomixupload');
      expect(options).toContain('endpoint=us-east');
      expect(options).not.toContain('endpoint=auto');
    });

    it('should deduplicate flags keeping last occurrence', () => {
      const options = resolveS3fsOptions('minio', [
        'use_path_request_style',
        'custom_flag'
      ]);
      const count = options.filter(
        (o) => o === 'use_path_request_style'
      ).length;
      expect(count).toBe(1);
      expect(options).toContain('custom_flag');
    });

    it('should use safe defaults for unknown providers', () => {
      const options = resolveS3fsOptions(null, ['nomixupload']);
      expect(options).toContain('use_path_request_style');
      expect(options).toContain('nomixupload');
    });
  });
});
