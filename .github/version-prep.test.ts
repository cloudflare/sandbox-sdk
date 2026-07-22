import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSdkVersionSource } from './version-prep.ts';

const FILE = `/**\n * SDK version\n */\nexport const SDK_VERSION = '0.12.4';\n`;

describe('updateSdkVersionSource', () => {
  test('rewrites the SDK_VERSION constant to the new version', () => {
    const result = updateSdkVersionSource(FILE, '0.12.5');
    assert.match(result, /export const SDK_VERSION = '0\.12\.5';/);
    assert.doesNotMatch(result, /0\.12\.4/);
  });

  test('preserves surrounding comment lines', () => {
    const result = updateSdkVersionSource(FILE, '1.0.0');
    assert.match(result, /\* SDK version/);
  });

  test('throws when the constant is missing instead of silently succeeding', () => {
    assert.throws(
      () => updateSdkVersionSource('export const OTHER = 1;\n', '0.12.5'),
      /SDK_VERSION constant not found/
    );
  });
});
