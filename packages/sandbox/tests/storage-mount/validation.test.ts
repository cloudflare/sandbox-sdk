import { describe, expect, it } from 'vitest';
import {
  buildS3fsSource,
  validateBucketName,
  validatePrefix
} from '../../src/storage-mount/validation';

describe('validatePrefix', () => {
  it.each(['/', '/data', '/data/', '/a/b/c', '/a/b/c/', '/sessions/abc123'])(
    'accepts valid prefix: %s',
    (prefix) => {
      expect(() => validatePrefix(prefix)).not.toThrow();
    }
  );

  it.each([
    ['data', "start with '/'"],
    ['data/', "start with '/'"],
    ['sessions/abc123', "start with '/'"]
  ])('rejects invalid prefix: %s', (prefix, expectedMsg) => {
    expect(() => validatePrefix(prefix)).toThrow(expectedMsg);
  });
});

describe('validateBucketName', () => {
  it.each(['my-bucket', 'test.bucket.name', 'a1b2c3'])(
    'accepts valid bucket name: %s',
    (bucket) => {
      expect(() => validateBucketName(bucket, '/mount')).not.toThrow();
    }
  );

  it('rejects bucket name with colon and suggests prefix option', () => {
    expect(() => validateBucketName('mybucket:/data/path', '/mount')).toThrow(
      "Bucket name cannot contain ':'"
    );
    expect(() => validateBucketName('mybucket:/data/path', '/mount')).toThrow(
      "prefix: '/data/path'"
    );
  });

  it.each(['UPPERCASE', 'has spaces', '-starts-with-dash', 'ends-with-dash-'])(
    'rejects invalid bucket name: %s',
    (bucket) => {
      expect(() => validateBucketName(bucket, '/mount')).toThrow(
        'Invalid bucket name'
      );
    }
  );
});

describe('buildS3fsSource', () => {
  it('returns bucket name without prefix', () => {
    expect(buildS3fsSource('my-bucket')).toBe('my-bucket');
  });

  it('returns bucket:/prefix/ format with prefix', () => {
    expect(buildS3fsSource('my-bucket', '/data/')).toBe('my-bucket:/data/');
  });
});
