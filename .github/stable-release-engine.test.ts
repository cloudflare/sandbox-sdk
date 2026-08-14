import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { commitSHA, imageDigest, stableVersion } from './release-primitives.ts';
import {
  inspectStableReleasePlan,
  runStableReleaseEngine
} from './stable-release-engine.ts';
import { FakeReleasePlatform } from './test/release-platform-fake.ts';
import { makeContext, makePreparedRelease } from './test/release-builders.ts';

const WRONG_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
const SOURCE_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('runStableReleaseEngine', () => {
  test('scenario new current stable release creates missing artifacts and advances latest', async () => {
    const platform = seededPlatformWithSourceImage();

    const result = await runStableReleaseEngine({
      context: makeContext(),
      platform,
      prepare: async () => makePreparedRelease()
    });

    assert.equal(result.finalPlan.operations.length, 0);
    assert.equal(platform.distTags.get('@cloudflare/sandbox:latest'), '1.2.3');
    assert.equal(
      platform.operations.at(-1),
      'npm.publish /tmp/pkg/pkg.tgz latest'
    );
    assert.equal(
      platform.operations.some((operation) =>
        operation.startsWith('npm.distTag')
      ),
      false
    );
  });

  test('scenario already complete release performs no mutation', async () => {
    const platform = seededCompletePlatform();

    const result = await runStableReleaseEngine({
      context: makeContext(),
      platform,
      prepare: async () => makePreparedRelease()
    });

    assert.deepEqual(result.initialPlan.operations, []);
    assert.deepEqual(platform.operations, []);
  });

  test('scenario partial apply failure is recoverable by retry', async () => {
    const platform = seededPlatformWithSourceImage();
    platform.github.uploadAsset = async () => {
      throw new Error('upload failed');
    };

    await assert.rejects(
      runStableReleaseEngine({
        context: makeContext(),
        platform,
        prepare: async () => makePreparedRelease()
      }),
      /upload failed/
    );

    const retryPlatform = seededCompleteExceptGitHubAssetsFrom(platform);
    const retry = await runStableReleaseEngine({
      context: makeContext(),
      platform: retryPlatform,
      prepare: async () => makePreparedRelease()
    });
    assert.equal(retry.finalPlan.operations.length, 0);
  });

  test('scenario remote race creates conflicting docker tag during apply', async () => {
    const platform = seededPlatformWithSourceImage();
    platform.docker.copyImage = async (_source, target) => {
      platform.digests.set(
        `${target.repository}:${target.tag}`,
        imageDigest(
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        )
      );
    };

    await assert.rejects(
      runStableReleaseEngine({
        context: makeContext(),
        platform,
        prepare: async () => makePreparedRelease()
      }),
      /reinspect failed/
    );
  });

  test('scenario remote race creates matching docker tag during apply', async () => {
    const platform = seededPlatformWithSourceImage();
    platform.docker.copyImage = async (source, target) => {
      const digest = platform.digests.get(`${source.repository}:${source.tag}`);
      if (digest === undefined) throw new Error('source digest missing');
      platform.digests.set(`${target.repository}:${target.tag}`, digest);
    };

    const result = await runStableReleaseEngine({
      context: makeContext(),
      platform,
      prepare: async () => makePreparedRelease()
    });

    assert.deepEqual(result.finalPlan.operations, []);
  });

  test('cleans once on conflict before mutation', async () => {
    const platform = new FakeReleasePlatform();
    const context = makeContext();
    platform.gitTags.set(context.versionTag, commitSHA(WRONG_SHA));
    const cleaned: string[] = [];

    await assert.rejects(
      runStableReleaseEngine({
        context,
        platform,
        prepare: async () => ({
          ...makePreparedRelease(),
          cleanup: async () => {
            cleaned.push('clean');
          }
        })
      }),
      /git\.versionTag: tag @cloudflare\/sandbox@1\.2\.3 points to f{40}/
    );

    assert.deepEqual(platform.operations, []);
    assert.deepEqual(cleaned, ['clean']);
  });

  test('applies missing operations and reinspects fresh state', async () => {
    const platform = new FakeReleasePlatform();
    platform.digests.set(
      'registry.cloudflare.com/cf-account/sandbox:ci-abc',
      imageDigest(SOURCE_DIGEST)
    );
    const cleaned: string[] = [];

    const result = await runStableReleaseEngine({
      context: makeContext(),
      platform,
      prepare: async () => ({
        ...makePreparedRelease(),
        cleanup: async () => {
          cleaned.push('clean');
        }
      })
    });

    assert.equal(result.reinspectionComplete, true);
    assert.equal(result.initialPlan.operations.length > 0, true);
    assert.deepEqual(result.finalPlan.operations, []);
    assert.deepEqual(cleaned, ['clean']);
  });

  test('retries reinspection while published state propagates', async () => {
    const platform = seededPlatformWithSourceImage();
    const inspectVersion = platform.npm.inspectVersion;
    const publishPreparedPackage = platform.npm.publishPreparedPackage;
    let published = false;
    let hiddenInspections = 0;
    let delays = 0;

    platform.npm.inspectVersion = async (name, version) => {
      if (published && hiddenInspections === 0) {
        hiddenInspections += 1;
        return undefined;
      }
      return inspectVersion(name, version);
    };
    platform.npm.publishPreparedPackage = async (prepared, npmTag) => {
      await publishPreparedPackage(prepared, npmTag);
      published = true;
    };

    const result = await runStableReleaseEngine({
      context: makeContext(),
      platform,
      prepare: async () => makePreparedRelease(),
      reinspectionDelay: async () => {
        delays += 1;
      }
    });

    assert.deepEqual(result.finalPlan.operations, []);
    assert.equal(hiddenInspections, 1);
    assert.equal(delays, 1);
    assert.equal(
      platform.operations.filter((operation) =>
        operation.startsWith('npm.publish')
      ).length,
      1
    );
  });

  test('cleans once when applying an operation fails', async () => {
    const platform = new FakeReleasePlatform();
    const cleaned: string[] = [];
    platform.digests.set(
      'registry.cloudflare.com/cf-account/sandbox:ci-abc',
      imageDigest(SOURCE_DIGEST)
    );
    platform.npm.publishPreparedPackage = async () => {
      throw new Error('publish failed');
    };

    await assert.rejects(
      runStableReleaseEngine({
        context: makeContext(),
        platform,
        prepare: async () => ({
          ...makePreparedRelease(),
          cleanup: async () => {
            cleaned.push('clean');
          }
        })
      }),
      /publish failed/
    );

    assert.deepEqual(cleaned, ['clean']);
  });

  test('preserves primary apply error when cleanup also fails', async () => {
    const platform = seededPlatformWithSourceImage();
    platform.npm.publishPreparedPackage = async () => {
      throw new Error('publish failed');
    };

    await assert.rejects(
      runStableReleaseEngine({
        context: makeContext(),
        platform,
        prepare: async () => ({
          ...makePreparedRelease(),
          cleanup: async () => {
            throw new Error('cleanup failed');
          }
        })
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /publish failed/);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /publish failed/);
        assert.match(String(error.errors[1]), /cleanup failed/);
        return true;
      }
    );
  });

  test('does not publish npm when an earlier Docker copy fails', async () => {
    const platform = seededPlatformWithSourceImage();
    platform.docker.copyImage = async () => {
      throw new Error('copy failed');
    };

    await assert.rejects(
      runStableReleaseEngine({
        context: makeContext(),
        platform,
        prepare: async () => makePreparedRelease()
      }),
      /copy failed/
    );

    assert.equal(platform.npmVersions.size, 0);
    assert.equal(
      platform.operations.some((operation) =>
        operation.startsWith('npm.publish')
      ),
      false
    );
  });

  test('creates git tag before npm publish so identity recovery remains valid', async () => {
    const platform = seededPlatformWithSourceImage();
    const context = makeContext();
    let sawTag = false;
    const originalPublish = platform.npm.publishPreparedPackage.bind(
      platform.npm
    );
    platform.npm.publishPreparedPackage = async (prepared, npmTag) => {
      assert.equal(
        platform.gitTags.get(context.versionTag),
        context.releaseSHA
      );
      sawTag = true;
      return originalPublish(prepared, npmTag);
    };

    await runStableReleaseEngine({
      context,
      platform,
      prepare: async () => makePreparedRelease()
    });

    assert.equal(sawTag, true);
    assert.equal(platform.gitTags.get(context.versionTag), context.releaseSHA);
  });

  test('uses the planned npm tag and preserves newer historical latest', async () => {
    const platform = new FakeReleasePlatform();
    const context = { ...makeContext(), mode: 'historical' as const };
    platform.distTags.set('@cloudflare/sandbox:latest', stableVersion('2.0.0'));
    platform.digests.set(
      'registry.cloudflare.com/cf-account/sandbox:ci-abc',
      imageDigest(SOURCE_DIGEST)
    );

    await runStableReleaseEngine({
      context,
      platform,
      prepare: async () => makePreparedRelease()
    });

    assert.equal(
      platform.operations.includes(
        'npm.publish /tmp/pkg/pkg.tgz release-1-2-3'
      ),
      true
    );
    assert.equal(
      platform.operations.some((operation) =>
        operation.startsWith('npm.distTag')
      ),
      false
    );
    assert.equal(platform.distTags.get('@cloudflare/sandbox:latest'), '2.0.0');
  });
});

function seededPlatformWithSourceImage(): FakeReleasePlatform {
  const platform = new FakeReleasePlatform();
  platform.digests.set(
    'registry.cloudflare.com/cf-account/sandbox:ci-abc',
    imageDigest(SOURCE_DIGEST)
  );
  return platform;
}

function seededCompletePlatform(): FakeReleasePlatform {
  const platform = seededPlatformWithSourceImage();
  const context = makeContext();
  platform.npmVersions.set('@cloudflare/sandbox@1.2.3', {
    version: context.version
  });
  platform.distTags.set('@cloudflare/sandbox:latest', context.version);
  platform.gitTags.set(context.versionTag, context.releaseSHA);
  platform.releases.set(context.versionTag, {
    tagName: context.versionTag,
    assets: ['sandbox-linux-x64', 'sandbox-linux-x64.sha256']
  });
  platform.digests.set(
    'docker.io/cloudflare/sandbox:1.2.3',
    imageDigest(SOURCE_DIGEST)
  );
  platform.digests.set(
    'registry.cloudflare.com/library/sandbox:1.2.3',
    imageDigest(SOURCE_DIGEST)
  );
  return platform;
}

function seededCompleteExceptGitHubAssetsFrom(
  source: FakeReleasePlatform
): FakeReleasePlatform {
  const platform = seededCompletePlatform();
  const context = makeContext();
  platform.releases.set(context.versionTag, {
    tagName: context.versionTag,
    assets: []
  });
  for (const [key, value] of source.digests) platform.digests.set(key, value);
  return platform;
}

describe('inspectStableReleasePlan', () => {
  test('returns a read-only plan and cleans once', async () => {
    const platform = new FakeReleasePlatform();
    platform.digests.set(
      'registry.cloudflare.com/cf-account/sandbox:ci-abc',
      imageDigest(SOURCE_DIGEST)
    );
    const cleaned: string[] = [];

    const plan = await inspectStableReleasePlan({
      context: makeContext(),
      platform,
      prepare: async () => ({
        ...makePreparedRelease(),
        cleanup: async () => {
          cleaned.push('clean');
        }
      })
    });

    assert.equal(plan.operations.length > 0, true);
    assert.deepEqual(platform.operations, []);
    assert.deepEqual(cleaned, ['clean']);
  });
});
