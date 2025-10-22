import { describe, test, expect } from 'vitest';
import { SDK_VERSION } from '../src/version';
import packageJson from '../package.json';

describe('Version Sync', () => {
  test('SDK_VERSION matches package.json version', () => {
    // Verify versions match
    expect(SDK_VERSION).toBe(packageJson.version);
  });

  test('SDK_VERSION is a valid semver version', () => {
    // Check if version matches semver pattern (major.minor.patch)
    const semverPattern = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
    expect(SDK_VERSION).toMatch(semverPattern);
  });
});
