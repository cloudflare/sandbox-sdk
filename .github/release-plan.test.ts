import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Decision } from './release-decisions.ts';
import type { StableInspection } from './release-inspect.ts';
import { planStableRelease } from './release-plan.ts';
import { imageDigest, stableVersion } from './release-primitives.ts';
import { makeContext, makePreparedRelease } from './test/release-builders.ts';

type InspectionOptions = {
  git?: 'matching' | 'missing' | 'wrong';
  docker?: 'matching' | 'missing' | 'wrong';
  github?: 'matching' | 'missing' | 'missing-assets' | 'wrong';
  latest?: string | 'missing';
  npm?: 'matching' | 'missing' | 'wrong';
};

describe('planStableRelease', () => {
  test('scenario historical reconciliation preserves newer latest', () => {
    const context = { ...makeContext(), mode: 'historical' as const };
    const plan = planStableRelease(
      context,
      inspection({ latest: '1.2.4' }),
      makePreparedRelease()
    );

    assert.deepEqual(plan.latestAction, {
      type: 'preserve',
      version: '1.2.4'
    });
    assert.deepEqual(plan.conflicts, []);
  });

  test('scenario current release rejects newer latest', () => {
    const plan = planStableRelease(
      makeContext(),
      inspection({ latest: '1.2.4' }),
      makePreparedRelease()
    );

    assert.match(
      plan.conflicts.join('\n'),
      /current latest 1\.2\.4 is newer than requested 1\.2\.3/
    );
    assert.deepEqual(plan.operations, []);
  });

  test('returns no operations when conflicts exist', () => {
    const plan = planStableRelease(
      makeContext(),
      inspection({ git: 'wrong', docker: 'wrong' }),
      makePreparedRelease()
    );

    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.conflicts, [
      'git.versionTag: wrong SHA',
      'docker.io/cloudflare/sandbox:1.2.3: wrong digest'
    ]);
  });

  test('uses exact inspected docker source and target refs', () => {
    const plan = planStableRelease(
      makeContext(),
      inspection({ docker: 'missing' }),
      makePreparedRelease()
    );

    assert.deepEqual(
      plan.operations.filter((operation) => operation.type === 'copy-docker'),
      [
        {
          type: 'copy-docker',
          source: {
            repository: 'registry.cloudflare.com/cf-account/sandbox',
            tag: 'ci-abc'
          },
          target: {
            repository: 'docker.io/cloudflare/sandbox',
            tag: '1.2.3'
          }
        }
      ]
    );
  });

  test('plans required GitHub asset uploads from prepared outputs', () => {
    const plan = planStableRelease(
      makeContext(),
      inspection({ github: 'missing-assets' }),
      makePreparedRelease()
    );

    assert.deepEqual(
      plan.operations.filter(
        (operation) => operation.type === 'upload-github-asset'
      ),
      [
        {
          type: 'upload-github-asset',
          releaseTag: makeContext().versionTag,
          name: 'sandbox-linux-x64',
          path: '/tmp/assets/sandbox-linux-x64'
        },
        {
          type: 'upload-github-asset',
          releaseTag: makeContext().versionTag,
          name: 'sandbox-linux-x64.sha256',
          path: '/tmp/assets/sandbox-linux-x64.sha256'
        }
      ]
    );
  });

  test('preserves newer latest for historical mode', () => {
    const context = { ...makeContext(), mode: 'historical' as const };
    const plan = planStableRelease(
      context,
      inspection({ latest: '1.2.4' }),
      makePreparedRelease()
    );

    assert.deepEqual(plan.latestAction, {
      type: 'preserve',
      version: '1.2.4'
    });
  });

  test('publishes a missing current version to absent or older latest', () => {
    for (const latest of ['missing', '1.2.2'] as const) {
      const prepared = makePreparedRelease();
      const plan = planStableRelease(
        makeContext(),
        inspection({ npm: 'missing', latest }),
        prepared
      );
      assert.deepEqual(plan.latestAction, { type: 'set', version: '1.2.3' });
      assert.deepEqual(
        plan.operations.filter((operation) => operation.type === 'publish-npm'),
        [
          {
            type: 'publish-npm',
            prepared: prepared.npm,
            npmTag: 'latest'
          }
        ]
      );
    }
  });

  test('requires maintainer authentication when a published version is not latest', () => {
    for (const latest of ['missing', '1.2.2'] as const) {
      const plan = planStableRelease(
        makeContext(),
        inspection({ latest }),
        makePreparedRelease()
      );

      assert.deepEqual(plan.operations, []);
      assert.deepEqual(plan.conflicts, [
        'npm.latest: @cloudflare/sandbox@1.2.3 is already published but latest does not point to it; run "npm dist-tag add @cloudflare/sandbox@1.2.3 latest" with maintainer authentication, then retry'
      ]);
    }
  });

  test('leaves equal latest unchanged', () => {
    const equal = planStableRelease(
      makeContext(),
      inspection({ latest: '1.2.3' }),
      makePreparedRelease()
    );
    assert.deepEqual(equal.latestAction, { type: 'none' });
  });

  test('rejects a newer latest for current mode', () => {
    const plan = planStableRelease(
      makeContext(),
      inspection({ latest: '1.2.4' }),
      makePreparedRelease()
    );

    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.conflicts, [
      'npm.latest: current latest 1.2.4 is newer than requested 1.2.3'
    ]);
  });

  test('plans each missing immutable domain using inspected metadata', () => {
    const context = makeContext();
    const prepared = makePreparedRelease();
    const plan = planStableRelease(
      context,
      inspection({
        npm: 'missing',
        git: 'missing',
        github: 'missing',
        docker: 'missing',
        latest: 'missing'
      }),
      prepared
    );

    assert.deepEqual(plan.operations, [
      {
        type: 'create-git-tag',
        tag: context.versionTag,
        sha: context.releaseSHA
      },
      {
        type: 'create-github-release',
        tag: context.versionTag,
        sha: context.releaseSHA,
        notes: context.changelogBody
      },
      {
        type: 'upload-github-asset',
        releaseTag: context.versionTag,
        name: 'sandbox-linux-x64',
        path: '/tmp/assets/sandbox-linux-x64'
      },
      {
        type: 'upload-github-asset',
        releaseTag: context.versionTag,
        name: 'sandbox-linux-x64.sha256',
        path: '/tmp/assets/sandbox-linux-x64.sha256'
      },
      {
        type: 'copy-docker',
        source: {
          repository: 'registry.cloudflare.com/cf-account/sandbox',
          tag: 'ci-abc'
        },
        target: {
          repository: 'docker.io/cloudflare/sandbox',
          tag: '1.2.3'
        }
      },
      {
        type: 'publish-npm',
        prepared: prepared.npm,
        npmTag: 'latest'
      }
    ]);
  });

  test('orders git tag first and current npm publish last', () => {
    const prepared = makePreparedRelease();
    const plan = planStableRelease(
      makeContext(),
      inspection({
        npm: 'missing',
        git: 'missing',
        latest: 'missing'
      }),
      prepared
    );

    assert.deepEqual(
      plan.operations.map((operation) => operation.type),
      ['create-git-tag', 'publish-npm']
    );
  });

  test('publishes a missing historical version without moving newer latest', () => {
    const context = { ...makeContext(), mode: 'historical' as const };
    const prepared = makePreparedRelease();
    const plan = planStableRelease(
      context,
      inspection({ npm: 'missing', latest: '1.2.4' }),
      prepared
    );

    assert.deepEqual(plan.latestAction, {
      type: 'preserve',
      version: '1.2.4'
    });
    assert.deepEqual(
      plan.operations.filter((operation) => operation.type === 'publish-npm'),
      [
        {
          type: 'publish-npm',
          prepared: prepared.npm,
          npmTag: 'release-1-2-3'
        }
      ]
    );
  });

  test('publishes a current release directly to latest', () => {
    const prepared = makePreparedRelease();
    const plan = planStableRelease(
      makeContext(),
      inspection({ npm: 'missing', latest: 'missing' }),
      prepared
    );

    assert.deepEqual(
      plan.operations.filter((operation) => operation.type === 'publish-npm'),
      [
        {
          type: 'publish-npm',
          prepared: prepared.npm,
          npmTag: 'latest'
        }
      ]
    );
  });

  test('publishes a historical release under a non-latest tag when latest is absent', () => {
    const context = { ...makeContext(), mode: 'historical' as const };
    const prepared = makePreparedRelease();
    const plan = planStableRelease(
      context,
      inspection({ npm: 'missing', latest: 'missing' }),
      prepared
    );

    assert.deepEqual(plan.latestAction, { type: 'none' });
    assert.deepEqual(
      plan.operations.filter((operation) => operation.type === 'publish-npm'),
      [
        {
          type: 'publish-npm',
          prepared: prepared.npm,
          npmTag: 'release-1-2-3'
        }
      ]
    );
  });
});

function inspection(options: InspectionOptions = {}): StableInspection {
  const version = stableVersion('1.2.3');
  const latest = options.latest ?? '1.2.3';
  const github = options.github ?? 'matching';
  return {
    npm: {
      version: decision(
        options.npm ?? 'matching',
        { version },
        'wrong version'
      ),
      latest:
        latest === 'missing'
          ? { state: 'missing' }
          : {
              state: 'matching',
              observed: { version: stableVersion(latest) }
            }
    },
    git: {
      versionTag: decision(
        options.git ?? 'matching',
        { sha: makeContext().releaseSHA },
        'wrong SHA'
      )
    },
    github: {
      release: decision(
        github === 'missing-assets' ? 'matching' : github,
        { tagName: makeContext().versionTag },
        'wrong release'
      ),
      assets: makePreparedRelease().assets.map((asset) => ({
        ...asset,
        decision:
          github === 'missing' || github === 'missing-assets'
            ? { state: 'missing' as const }
            : { state: 'matching' as const, observed: { name: asset.name } }
      }))
    },
    docker: {
      targets: [
        {
          sourceRef: {
            repository: 'registry.cloudflare.com/cf-account/sandbox',
            tag: 'ci-abc'
          },
          targetRef: {
            repository: 'docker.io/cloudflare/sandbox',
            tag: '1.2.3'
          },
          decision: decision(
            options.docker ?? 'matching',
            {
              digest: imageDigest(
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
              )
            },
            'wrong digest'
          )
        }
      ]
    }
  };
}

function decision<T>(
  state: 'matching' | 'missing' | 'wrong',
  observed: T,
  conflict: string
): Decision<T, string> {
  if (state === 'missing') return { state: 'missing' };
  if (state === 'wrong') return { state: 'conflict', conflict };
  return { state: 'matching', observed };
}
