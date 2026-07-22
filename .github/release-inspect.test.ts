import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OperationalReleaseError } from './release-errors.ts';
import { inspectStableRelease } from './release-inspect.ts';
import { commitSHA, imageDigest } from './release-primitives.ts';
import { makeContext, makePreparedRelease } from './test/release-builders.ts';
import { FakeReleasePlatform } from './test/release-platform-fake.ts';

describe('inspectStableRelease', () => {
  test('scenario version tag resolves to wrong SHA', async () => {
    const platform = new FakeReleasePlatform();
    const context = makeContext();
    platform.gitTags.set(
      context.versionTag,
      commitSHA('ffffffffffffffffffffffffffffffffffffffff')
    );

    const inspection = await inspectStableRelease(
      context,
      makePreparedRelease(),
      platform
    );

    assert.equal(inspection.git.versionTag.state, 'conflict');
  });

  test('scenario existing GitHub Release missing required asset is recoverable', async () => {
    const platform = new FakeReleasePlatform();
    const context = makeContext();
    platform.releases.set(context.versionTag, {
      tagName: context.versionTag,
      assets: ['sandbox-linux-x64']
    });

    const inspection = await inspectStableRelease(
      context,
      makePreparedRelease(),
      platform
    );
    const missingAsset = inspection.github.assets.find(
      (asset) => asset.name === 'sandbox-linux-x64.sha256'
    );

    assert.equal(inspection.github.release.state, 'matching');
    assert.equal(missingAsset?.decision.state, 'missing');
  });

  test('scenario existing GitHub Release with wrong tag conflicts', async () => {
    const platform = new FakeReleasePlatform();
    const context = makeContext();
    platform.releases.set(context.versionTag, {
      tagName: '@cloudflare/sandbox@1.2.2',
      assets: ['sandbox-linux-x64', 'sandbox-linux-x64.sha256']
    });

    const inspection = await inspectStableRelease(
      context,
      makePreparedRelease(),
      platform
    );

    assert.equal(inspection.github.release.state, 'conflict');
  });

  test('retains exact docker refs and reports digest conflicts', async () => {
    const platform = new FakeReleasePlatform();
    const context = makeContext();
    platform.digests.set(
      'registry.cloudflare.com/cf-account/sandbox:ci-abc',
      imageDigest(
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    );
    platform.digests.set(
      'docker.io/cloudflare/sandbox:1.2.3',
      imageDigest(
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      )
    );

    const inspection = await inspectStableRelease(
      context,
      makePreparedRelease(),
      platform
    );
    const target = inspection.docker.targets[0];

    assert.equal(
      target.sourceRef.repository,
      'registry.cloudflare.com/cf-account/sandbox'
    );
    assert.equal(target.targetRef.repository, 'docker.io/cloudflare/sandbox');
    assert.equal(
      target.expectedDigest,
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    assert.equal(target.decision.state, 'conflict');
  });

  test('caches one source digest read across public targets', async () => {
    const platform = new FakeReleasePlatform();
    const context = makeContext();
    const sourceKey = 'registry.cloudflare.com/cf-account/sandbox:ci-abc';
    platform.digests.set(
      sourceKey,
      imageDigest(
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    );
    let sourceReads = 0;
    const originalResolveDigest = platform.docker.resolveDigest;
    platform.docker.resolveDigest = async (ref) => {
      if (`${ref.repository}:${ref.tag}` === sourceKey) sourceReads += 1;
      return originalResolveDigest(ref);
    };

    const inspection = await inspectStableRelease(
      context,
      makePreparedRelease(),
      platform
    );

    assert.equal(inspection.docker.targets.length, 2);
    assert.equal(sourceReads, 1);
  });

  test('reports a missing source digest as a conflict', async () => {
    const inspection = await inspectStableRelease(
      makeContext(),
      makePreparedRelease(),
      new FakeReleasePlatform()
    );

    assert.equal(inspection.docker.targets[0].decision.state, 'conflict');
    assert.match(
      inspection.docker.targets[0].decision.state === 'conflict'
        ? inspection.docker.targets[0].decision.conflict
        : '',
      /source image .* is missing/
    );
  });

  test('retains prepared asset metadata and reports missing assets', async () => {
    const inspection = await inspectStableRelease(
      makeContext(),
      makePreparedRelease(),
      new FakeReleasePlatform()
    );

    assert.deepEqual(
      inspection.github.assets.map(({ name, path, decision }) => ({
        name,
        path,
        state: decision.state
      })),
      [
        {
          name: 'sandbox-linux-x64',
          path: '/tmp/assets/sandbox-linux-x64',
          state: 'missing'
        },
        {
          name: 'sandbox-linux-x64.sha256',
          path: '/tmp/assets/sandbox-linux-x64.sha256',
          state: 'missing'
        }
      ]
    );
  });

  test('wraps GitHub failures as github errors, not npm errors', async () => {
    const platform = new FakeReleasePlatform();
    platform.github.inspectRelease = async () => {
      throw new Error('HTTP 500');
    };

    await assert.rejects(
      inspectStableRelease(makeContext(), makePreparedRelease(), platform),
      (error: unknown) => {
        assert.ok(error instanceof OperationalReleaseError);
        assert.equal(error.phase, 'inspect');
        assert.equal(error.domain, 'github');
        assert.match(error.message, /inspect github failed: HTTP 500/);
        assert.ok(error.originalError instanceof Error);
        return true;
      }
    );
  });
});
