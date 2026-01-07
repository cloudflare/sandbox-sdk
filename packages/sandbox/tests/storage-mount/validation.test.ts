import { describe, expect, it } from 'vitest';
import {
  buildS3fsSource,
  validatePrefix
} from '../../src/storage-mount/validation';

describe('validatePrefix', () => {
  it.each(['/', '/data/', '/a/b/c/'])('accepts valid prefix: %s', (prefix) => {
    expect(() => validatePrefix(prefix)).not.toThrow();
  });

  it.each([
    ['data/', "start with '/'"],
    ['/data', "end with '/'"]
  ])('rejects invalid prefix: %s', (prefix, expectedMsg) => {
    expect(() => validatePrefix(prefix)).toThrow(expectedMsg);
  });
});

describe('buildS3fsSource', () => {
  it('returns bucket name without prefix', () => {
    expect(buildS3fsSource('my-bucket')).toBe('my-bucket');
  });

  it('returns bucket:/prefix/ format with prefix', () => {
    expect(buildS3fsSource('my-bucket', '/data/')).toBe('my-bucket:/data/');
  });
});
