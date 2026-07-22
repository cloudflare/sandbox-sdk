import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { stableVersion } from './release-primitives.ts';
import { compareStableSemver, parseStableSemver } from './release-semver.ts';

describe('stable semver parser', () => {
  test('parses numeric stable parts', () => {
    assert.deepEqual(parseStableSemver(stableVersion('10.20.30')), {
      major: 10,
      minor: 20,
      patch: 30
    });
  });

  test('compares numerically instead of lexically', () => {
    assert.equal(
      compareStableSemver(stableVersion('1.10.0'), stableVersion('1.2.9')),
      1
    );
    assert.equal(
      compareStableSemver(stableVersion('1.2.0'), stableVersion('1.2.0')),
      0
    );
    assert.equal(
      compareStableSemver(stableVersion('1.2.0'), stableVersion('1.2.1')),
      -1
    );
  });

  test('rejects components outside the safe integer range', () => {
    assert.throws(
      () => parseStableSemver(stableVersion('9007199254740992.0.0')),
      /safe integer/
    );
    assert.throws(
      () => parseStableSemver(stableVersion('0.9007199254740992.0')),
      /safe integer/
    );
    assert.throws(
      () => parseStableSemver(stableVersion('0.0.9007199254740992')),
      /safe integer/
    );
  });
});
