import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareStableRelease,
  SANDBOX_BINARY_IN_IMAGE
} from './stable-release-preparation.ts';
import {
  absolutePath,
  commitSHA,
  npmPackageName,
  sourceTag,
  stableVersion,
  versionTag
} from './release-primitives.ts';
import type { StableReleaseContext } from './stable-release-context.ts';

describe('prepareStableRelease', () => {
  test('extracts the binary from the container image contract path', () => {
    assert.equal(SANDBOX_BINARY_IN_IMAGE, '/container-server/sandbox');
  });

  test('extracts both binaries from source images, writes checksums, validates all assets, and cleans once', async () => {
    const extracted: string[] = [];
    const checksummed: string[] = [];
    const removed: string[] = [];
    const npmCleaned: string[] = [];
    const prepared = await prepareStableRelease(makePreparationContext(), {
      makeTempDir: () => '/tmp/sandbox-assets-1',
      remove: (path) => removed.push(path),
      exists: () => true,
      extractBinary: async (sourceRef, outputPath) =>
        extracted.push(`${sourceRef}->${outputPath}`),
      writeSHA256: async (inputPath, checksumPath) =>
        checksummed.push(`${inputPath}->${checksumPath}`),
      prepareNpmPackage: async () => ({
        packageName: '@cloudflare/sandbox',
        version: '1.2.3',
        packageDir: '/tmp/pkg',
        tarballPath: '/tmp/pkg/pkg.tgz',
        cleanup: async () => npmCleaned.push('npm')
      })
    });

    assert.deepEqual(extracted, [
      'registry.cloudflare.com/cf-account/sandbox:ci-abc->/tmp/sandbox-assets-1/sandbox-linux-x64',
      'registry.cloudflare.com/cf-account/sandbox-musl:ci-abc->/tmp/sandbox-assets-1/sandbox-linux-x64-musl'
    ]);
    assert.deepEqual(checksummed, [
      '/tmp/sandbox-assets-1/sandbox-linux-x64->/tmp/sandbox-assets-1/sandbox-linux-x64.sha256',
      '/tmp/sandbox-assets-1/sandbox-linux-x64-musl->/tmp/sandbox-assets-1/sandbox-linux-x64-musl.sha256'
    ]);
    assert.deepEqual(prepared.requiredAssets, [
      'sandbox-linux-x64',
      'sandbox-linux-x64.sha256',
      'sandbox-linux-x64-musl',
      'sandbox-linux-x64-musl.sha256'
    ]);
    await prepared.cleanup();
    await prepared.cleanup();
    assert.deepEqual(npmCleaned, ['npm']);
    assert.deepEqual(removed, ['/tmp/sandbox-assets-1']);
  });

  test('cleans npm and asset temp dir when checksum validation fails', async () => {
    const removed: string[] = [];
    const npmCleaned: string[] = [];
    await assert.rejects(
      prepareStableRelease(makePreparationContext(), {
        makeTempDir: () => '/tmp/sandbox-assets-2',
        remove: (path) => removed.push(path),
        exists: (path) => !path.endsWith('sandbox-linux-x64-musl.sha256'),
        extractBinary: async () => undefined,
        writeSHA256: async () => undefined,
        prepareNpmPackage: async () => ({
          packageName: '@cloudflare/sandbox',
          version: '1.2.3',
          packageDir: '/tmp/pkg',
          tarballPath: '/tmp/pkg/pkg.tgz',
          cleanup: async () => npmCleaned.push('npm')
        })
      }),
      /Prepared release asset is missing: \/tmp\/sandbox-assets-2\/sandbox-linux-x64-musl\.sha256/
    );
    assert.deepEqual(npmCleaned, ['npm']);
    assert.deepEqual(removed, ['/tmp/sandbox-assets-2']);
  });

  test('attempts asset cleanup and retries npm cleanup after npm cleanup fails', async () => {
    const removed: string[] = [];
    let npmCleanupAttempts = 0;
    const prepared = await prepareStableRelease(makePreparationContext(), {
      makeTempDir: () => '/tmp/sandbox-assets-3',
      remove: (path) => removed.push(path),
      exists: () => true,
      extractBinary: async () => undefined,
      writeSHA256: async () => undefined,
      prepareNpmPackage: async () => ({
        packageName: '@cloudflare/sandbox',
        version: '1.2.3',
        packageDir: '/tmp/pkg',
        tarballPath: '/tmp/pkg/pkg.tgz',
        cleanup: async () => {
          npmCleanupAttempts += 1;
          if (npmCleanupAttempts === 1) {
            throw new Error('npm cleanup failed');
          }
        }
      })
    });

    await assert.rejects(prepared.cleanup(), /npm cleanup failed/);
    assert.deepEqual(removed, ['/tmp/sandbox-assets-3']);
    await prepared.cleanup();
    await prepared.cleanup();
    assert.equal(npmCleanupAttempts, 2);
    assert.deepEqual(removed, ['/tmp/sandbox-assets-3']);
  });
});

function makePreparationContext(): StableReleaseContext {
  const version = stableVersion('1.2.3');
  return Object.freeze({
    version,
    releaseSHA: commitSHA('0123456789abcdef0123456789abcdef01234567'),
    releaseRoot: absolutePath('/tmp/release-root'),
    sourceTag: sourceTag('ci-abc'),
    versionTag: versionTag('@cloudflare/sandbox@1.2.3'),
    dockerImages: [
      {
        image: 'sandbox',
        sourceTag: 'ci-abc',
        tag: '1.2.3',
        dockerHubRef: 'docker.io/cloudflare/sandbox:1.2.3',
        cfLibraryRef: 'registry.cloudflare.com/library/sandbox:1.2.3',
        sourceRef: 'registry.cloudflare.com/cf-account/sandbox:ci-abc'
      },
      {
        image: 'sandbox-musl',
        sourceTag: 'ci-abc',
        tag: '1.2.3-musl',
        dockerHubRef: 'docker.io/cloudflare/sandbox:1.2.3-musl',
        cfLibraryRef: 'registry.cloudflare.com/library/sandbox:1.2.3-musl',
        sourceRef: 'registry.cloudflare.com/cf-account/sandbox-musl:ci-abc'
      }
    ],
    npmPackageName: npmPackageName('@cloudflare/sandbox'),
    mode: 'current',
    changelogBody: '- Fixed release',
    requiredAssets: [
      'sandbox-linux-x64',
      'sandbox-linux-x64.sha256',
      'sandbox-linux-x64-musl',
      'sandbox-linux-x64-musl.sha256'
    ]
  });
}
