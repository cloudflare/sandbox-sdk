import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyPackageVersion,
  computePrereleaseVersion,
  parseBaseBump,
  parseChannel
} from './prerelease-channel.ts';

test('computes a minor prerelease version with run metadata', () => {
  const version = computePrereleaseVersion({
    baseVersion: '0.12.1',
    baseBump: 'minor',
    prereleaseIdentifier: 'next',
    runNumber: '1234',
    runAttempt: '2'
  });

  assert.equal(version, '0.13.0-next.1234.2');
});

test('computes a patch prerelease version by default', () => {
  const version = computePrereleaseVersion({
    baseVersion: '1.2.3',
    baseBump: 'patch',
    prereleaseIdentifier: 'beta',
    runNumber: '7',
    runAttempt: '1'
  });

  assert.equal(version, '1.2.4-beta.7.1');
});

test('rejects invalid channel names', () => {
  assert.throws(() => parseChannel('bad.tag'), /must only contain/);
  assert.throws(() => parseChannel(''), /is required/);
});

test('rejects invalid base bumps', () => {
  assert.throws(() => parseBaseBump('build'), /must be one of/);
});

test('applies a package version to package.json and SDK version', () => {
  const root = join(tmpdir(), `sandbox-prerelease-${process.pid}`);
  const packageDir = join(root, 'packages', 'sandbox');
  const srcDir = join(packageDir, 'src');
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify({ name: '@cloudflare/sandbox', version: '0.12.1' }, null, 2)}\n`
  );
  writeFileSync(
    join(srcDir, 'version.ts'),
    "export const SDK_VERSION = '0.12.1';\n"
  );

  applyPackageVersion(root, '0.13.0-next.1234.2');

  const packageJson = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8')
  ) as { version: string };
  const versionSource = readFileSync(join(srcDir, 'version.ts'), 'utf8');

  assert.equal(packageJson.version, '0.13.0-next.1234.2');
  assert.match(versionSource, /SDK_VERSION = '0\.13\.0-next\.1234\.2'/);
});
