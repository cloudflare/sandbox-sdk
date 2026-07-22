import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutePath,
  assertPathInside,
  commitSHA,
  stableVersion,
  versionTag
} from './release-primitives.ts';

describe('release primitives', () => {
  test('accepts exact stable release identities', () => {
    assert.equal(stableVersion('1.2.3'), '1.2.3');
    assert.equal(
      commitSHA('0123456789abcdef0123456789abcdef01234567'),
      '0123456789abcdef0123456789abcdef01234567'
    );
    assert.equal(
      versionTag('@cloudflare/sandbox@1.2.3'),
      '@cloudflare/sandbox@1.2.3'
    );
    assert.equal(absolutePath('/tmp/release-root'), '/tmp/release-root');
  });

  test('rejects ambiguous or non-stable identities', () => {
    assert.throws(
      () => stableVersion('v1.2.3'),
      /Stable version must be MAJOR\.MINOR\.PATCH/
    );
    assert.throws(
      () => stableVersion('1.2.3-beta.1'),
      /Stable version must be MAJOR\.MINOR\.PATCH/
    );
    assert.throws(
      () => versionTag('@cloudflare/sandbox@01.2.3'),
      /Invalid version tag/
    );
    assert.throws(
      () => commitSHA('abc123'),
      /Commit SHA must be 40 lowercase hex characters/
    );
    assert.throws(() => absolutePath('relative'), /Expected absolute path/);
  });

  test('allows in-root path segments that begin with two dots', () => {
    assert.equal(
      assertPathInside(absolutePath('/tmp/root'), '/tmp/root/..child'),
      '/tmp/root/..child'
    );
  });
});
