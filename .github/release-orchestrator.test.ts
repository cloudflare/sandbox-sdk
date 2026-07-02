import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prereleaseReleaseState, stableReleaseState } from './release-state.ts';
import {
  convergePrereleaseRelease,
  convergeStableRelease,
  ExecCommandRunner,
  FakeCommandRunner,
  verifyPrereleaseRelease,
  verifyStableRelease
} from './release-command-runner.ts';
import { parseCliArgs } from './release-orchestrator.ts';

describe('ExecCommandRunner', () => {
  test('recognizes lightweight and annotated git tags as existing tags', async () => {
    const originalCwd = process.cwd();
    const repoDir = mkdtempSync(join(tmpdir(), 'sandbox-release-tags-'));

    try {
      process.chdir(repoDir);
      execFileSync('git', ['init'], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com']);
      execFileSync('git', ['config', 'user.name', 'Test User']);
      execFileSync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], {
        stdio: 'ignore'
      });
      execFileSync('git', ['tag', 'lightweight-tag']);
      execFileSync('git', [
        'tag',
        '-a',
        'annotated-tag',
        '-m',
        'annotated-tag'
      ]);

      const runner = new ExecCommandRunner();

      assert.equal(await runner.exists('git-tag:lightweight-tag'), true);
      assert.equal(await runner.exists('git-tag:annotated-tag'), true);
    } finally {
      process.chdir(originalCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('surfaces unknown ref kinds instead of reporting them missing', async () => {
    const runner = new ExecCommandRunner();

    await assert.rejects(
      runner.exists('bogus:some-value'),
      /Unknown ref kind: bogus/
    );
  });
});

describe('verifyStableRelease', () => {
  test('reports missing stable artifacts with exact refs', async () => {
    const state = stableReleaseState({
      version: '0.12.2',
      sourceTag: 'ci-hash',
      commitSha: 'abc123',
      images: ['sandbox', 'sandbox-musl'],
      changelogBody: '### Patch Changes\n\n- Fix thing'
    });
    const runner = new FakeCommandRunner({ presentRefs: new Set() });

    const result = await verifyStableRelease(state, runner);

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.missing.sort(),
      [
        'docker:docker.io/cloudflare/sandbox:0.12.2',
        'docker:docker.io/cloudflare/sandbox:0.12.2-musl',
        'docker:registry.cloudflare.com/library/sandbox:0.12.2',
        'docker:registry.cloudflare.com/library/sandbox:0.12.2-musl',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64-musl',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64-musl.sha256',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64.sha256',
        'github-release-tag:@cloudflare/sandbox@0.12.2=@cloudflare/sandbox@0.12.2',
        'github-release:@cloudflare/sandbox@0.12.2',
        'git-tag:@cloudflare/sandbox@0.12.2',
        'npm:@cloudflare/sandbox@0.12.2',
        'npm-dist-tag:latest=0.12.2'
      ].sort()
    );
  });
});

describe('parseCliArgs', () => {
  test('parses verify-stable args', () => {
    assert.deepEqual(
      parseCliArgs([
        'verify-stable',
        '--version',
        '0.12.2',
        '--source-tag',
        'ci-hash',
        '--commit-sha',
        'abc123'
      ]),
      {
        command: 'verify-stable',
        version: '0.12.2',
        sourceTag: 'ci-hash',
        commitSha: 'abc123'
      }
    );
  });

  test('parses stable args with skip npm', () => {
    assert.deepEqual(
      parseCliArgs([
        'stable',
        '--version',
        '0.12.2',
        '--source-tag',
        'ci-hash',
        '--commit-sha',
        'abc123',
        '--skip-npm',
        'true'
      ]),
      {
        command: 'stable',
        version: '0.12.2',
        sourceTag: 'ci-hash',
        commitSha: 'abc123',
        skipNpm: true
      }
    );
  });

  test('parses stable args with skip npm flag', () => {
    assert.deepEqual(
      parseCliArgs([
        'stable',
        '--version',
        '0.12.2',
        '--source-tag',
        'ci-hash',
        '--commit-sha',
        'abc123',
        '--skip-npm'
      ]),
      {
        command: 'stable',
        version: '0.12.2',
        sourceTag: 'ci-hash',
        commitSha: 'abc123',
        skipNpm: true
      }
    );
  });

  test('parses prerelease args with optional docker alias', () => {
    assert.deepEqual(
      parseCliArgs([
        'prerelease',
        '--version',
        '0.13.0-next.1.1',
        '--source-tag',
        'prerelease-next-0.13.0-next.1.1',
        '--npm-tag',
        'next',
        '--docker-alias',
        'next'
      ]),
      {
        command: 'prerelease',
        version: '0.13.0-next.1.1',
        sourceTag: 'prerelease-next-0.13.0-next.1.1',
        npmTag: 'next',
        dockerAlias: 'next'
      }
    );
  });

  test('parses verify-prerelease args with optional docker alias', () => {
    assert.deepEqual(
      parseCliArgs([
        'verify-prerelease',
        '--version',
        '0.13.0-next.1.1',
        '--source-tag',
        'prerelease-next-0.13.0-next.1.1',
        '--npm-tag',
        'next',
        '--docker-alias',
        'next'
      ]),
      {
        command: 'verify-prerelease',
        version: '0.13.0-next.1.1',
        sourceTag: 'prerelease-next-0.13.0-next.1.1',
        npmTag: 'next',
        dockerAlias: 'next'
      }
    );
  });

  test('requires source tag', () => {
    assert.throws(
      () =>
        parseCliArgs([
          'verify-stable',
          '--version',
          '0.12.2',
          '--commit-sha',
          'abc123'
        ]),
      /--source-tag is required/
    );
  });
});

describe('convergeStableRelease', () => {
  test('throws before changing commands when existing tag points elsewhere', async () => {
    const state = stableReleaseState({
      version: '0.12.2',
      sourceTag: 'ci-hash',
      commitSha: 'abc123',
      images: ['sandbox', 'sandbox-musl'],
      changelogBody: '### Patch Changes\n\n- Fix thing'
    });
    const runner = new FakeCommandRunner({
      textByCommand: new Map([
        ['git rev-list -n 1 @cloudflare/sandbox@0.12.2', 'def456\n']
      ]),
      presentRefs: new Set([
        'npm:@cloudflare/sandbox@0.12.2',
        'npm-dist-tag:latest=0.12.2',
        'git-tag:@cloudflare/sandbox@0.12.2'
      ])
    });

    await assert.rejects(
      convergeStableRelease(state, runner, { skipNpm: true }),
      /Git tag @cloudflare\/sandbox@0\.12\.2 points to def456, expected abc123/
    );
    assert.deepEqual(runner.commands, [
      ['git', 'rev-list', '-n', '1', '@cloudflare/sandbox@0.12.2']
    ]);
  });

  test('pushes a newly-created annotated tag before creating release', async () => {
    const state = stableReleaseState({
      version: '0.12.2',
      sourceTag: 'ci-hash',
      commitSha: 'abc123',
      images: ['sandbox', 'sandbox-musl'],
      changelogBody: '### Patch Changes\n\n- Fix thing'
    });
    const runner = new FakeCommandRunner({
      presentRefs: new Set([
        'npm:@cloudflare/sandbox@0.12.2',
        'npm-dist-tag:latest=0.12.2',
        'docker:docker.io/cloudflare/sandbox:0.12.2',
        'docker:docker.io/cloudflare/sandbox:0.12.2-musl',
        'docker:registry.cloudflare.com/library/sandbox:0.12.2',
        'docker:registry.cloudflare.com/library/sandbox:0.12.2-musl',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64.sha256',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64-musl',
        'github-asset:@cloudflare/sandbox@0.12.2:sandbox-linux-x64-musl.sha256'
      ])
    });

    await convergeStableRelease(state, runner, { skipNpm: true });

    assert.deepEqual(runner.commands, [
      [
        'git',
        'tag',
        '-a',
        '@cloudflare/sandbox@0.12.2',
        'abc123',
        '-m',
        '@cloudflare/sandbox@0.12.2'
      ],
      ['git', 'push', 'origin', '@cloudflare/sandbox@0.12.2'],
      [
        'gh',
        'release',
        'create',
        '@cloudflare/sandbox@0.12.2',
        '--target',
        'abc123',
        '--title',
        '@cloudflare/sandbox@0.12.2',
        '--notes',
        '### Patch Changes\n\n- Fix thing'
      ]
    ]);
  });

  test('throws when an existing GitHub Release targets the wrong tag', async () => {
    const state = stableReleaseState({
      version: '0.12.2',
      sourceTag: 'ci-hash',
      commitSha: 'abc123',
      images: ['sandbox', 'sandbox-musl'],
      changelogBody: '### Patch Changes\n\n- Fix thing'
    });
    const runner = new FakeCommandRunner({
      textByCommand: new Map([
        ['git rev-list -n 1 @cloudflare/sandbox@0.12.2', 'abc123\n']
      ]),
      presentRefs: new Set([
        'npm:@cloudflare/sandbox@0.12.2',
        'npm-dist-tag:latest=0.12.2',
        'git-tag:@cloudflare/sandbox@0.12.2',
        'github-release:@cloudflare/sandbox@0.12.2'
      ])
    });

    await assert.rejects(
      convergeStableRelease(state, runner, { skipNpm: true }),
      /GitHub Release @cloudflare\/sandbox@0\.12\.2 is not attached to expected tag @cloudflare\/sandbox@0\.12\.2/
    );
  });

  test('copies missing docker tags and uploads stable assets', async () => {
    const state = stableReleaseState({
      version: '0.12.2',
      sourceTag: 'ci-hash',
      commitSha: 'abc123',
      images: ['sandbox', 'sandbox-musl'],
      changelogBody: '### Patch Changes\n\n- Fix thing'
    });
    const runner = new FakeCommandRunner({
      textByCommand: new Map([
        ['git rev-list -n 1 @cloudflare/sandbox@0.12.2', 'abc123\n'],
        [
          'docker create registry.cloudflare.com/cf-account-123/sandbox:ci-hash',
          'normal-container\n'
        ],
        [
          'docker create registry.cloudflare.com/cf-account-123/sandbox-musl:ci-hash',
          'musl-container\n'
        ]
      ]),
      presentRefs: new Set([
        'npm:@cloudflare/sandbox@0.12.2',
        'npm-dist-tag:latest=0.12.2',
        'git-tag:@cloudflare/sandbox@0.12.2',
        'github-release:@cloudflare/sandbox@0.12.2',
        'github-release-tag:@cloudflare/sandbox@0.12.2=@cloudflare/sandbox@0.12.2'
      ])
    });

    await convergeStableRelease(state, runner, {
      skipNpm: true,
      cloudflareAccountId: 'cf-account-123'
    });

    assert.deepEqual(runner.commands, [
      ['git', 'rev-list', '-n', '1', '@cloudflare/sandbox@0.12.2'],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox:ci-hash',
        'docker.io/cloudflare/sandbox:0.12.2'
      ],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox:ci-hash',
        'registry.cloudflare.com/library/sandbox:0.12.2'
      ],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox-musl:ci-hash',
        'docker.io/cloudflare/sandbox:0.12.2-musl'
      ],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox-musl:ci-hash',
        'registry.cloudflare.com/library/sandbox:0.12.2-musl'
      ],
      [
        'docker',
        'pull',
        'registry.cloudflare.com/cf-account-123/sandbox:ci-hash'
      ],
      [
        'docker',
        'create',
        'registry.cloudflare.com/cf-account-123/sandbox:ci-hash'
      ],
      [
        'docker',
        'cp',
        'normal-container:/container-server/sandbox',
        './sandbox-linux-x64'
      ],
      ['docker', 'rm', 'normal-container'],
      [
        'docker',
        'pull',
        'registry.cloudflare.com/cf-account-123/sandbox-musl:ci-hash'
      ],
      [
        'docker',
        'create',
        'registry.cloudflare.com/cf-account-123/sandbox-musl:ci-hash'
      ],
      [
        'docker',
        'cp',
        'musl-container:/container-server/sandbox',
        './sandbox-linux-x64-musl'
      ],
      ['docker', 'rm', 'musl-container'],
      ['sh', '-c', 'sha256sum sandbox-linux-x64 > sandbox-linux-x64.sha256'],
      [
        'sh',
        '-c',
        'sha256sum sandbox-linux-x64-musl > sandbox-linux-x64-musl.sha256'
      ],
      [
        'gh',
        'release',
        'upload',
        '@cloudflare/sandbox@0.12.2',
        './sandbox-linux-x64',
        './sandbox-linux-x64.sha256',
        './sandbox-linux-x64-musl',
        './sandbox-linux-x64-musl.sha256',
        '--clobber'
      ]
    ]);
  });
});

describe('convergePrereleaseRelease', () => {
  test('publishes missing npm prerelease and docker aliases', async () => {
    const state = prereleaseReleaseState({
      version: '0.13.0-next.1.1',
      sourceTag: 'prerelease-next-0.13.0-next.1.1',
      npmTag: 'next',
      dockerAlias: 'next',
      images: ['sandbox']
    });
    const runner = new FakeCommandRunner({ presentRefs: new Set() });

    await convergePrereleaseRelease(state, runner, {
      skipNpm: false,
      cloudflareAccountId: 'cf-account-123'
    });

    assert.deepEqual(runner.commands.slice(0, 4), [
      ['npx', 'tsx', '.github/resolve-workspace-versions.ts'],
      [
        'npm',
        'publish',
        './packages/sandbox',
        '--tag',
        'next',
        '--access',
        'public'
      ],
      ['npm', 'dist-tag', 'add', '@cloudflare/sandbox@0.13.0-next.1.1', 'next'],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox:prerelease-next-0.13.0-next.1.1',
        'docker.io/cloudflare/sandbox:0.13.0-next.1.1'
      ]
    ]);
  });

  test('requires Cloudflare account ID before Docker convergence', async () => {
    const state = prereleaseReleaseState({
      version: '0.13.0-next.1.1',
      sourceTag: 'prerelease-next-0.13.0-next.1.1',
      npmTag: 'next',
      images: ['sandbox']
    });
    const runner = new FakeCommandRunner({
      presentRefs: new Set([
        'npm:@cloudflare/sandbox@0.13.0-next.1.1',
        'npm-dist-tag:next=0.13.0-next.1.1'
      ])
    });

    await assert.rejects(
      convergePrereleaseRelease(state, runner, {
        skipNpm: true,
        cloudflareAccountId: ''
      }),
      /CLOUDFLARE_ACCOUNT_ID is required to resolve Docker source image refs/
    );
    assert.deepEqual(runner.commands, []);
  });
});

describe('verifyPrereleaseRelease', () => {
  test('checks npm dist-tag and docker aliases with exact refs', async () => {
    const state = prereleaseReleaseState({
      version: '0.13.0-next.1.1',
      sourceTag: 'prerelease-next-0.13.0-next.1.1',
      npmTag: 'next',
      dockerAlias: 'next',
      images: ['sandbox']
    });
    const runner = new FakeCommandRunner({ presentRefs: new Set() });

    const result = await verifyPrereleaseRelease(state, runner);

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.missing.sort(),
      [
        'docker:docker.io/cloudflare/sandbox:0.13.0-next.1.1',
        'docker:docker.io/cloudflare/sandbox:next',
        'docker:registry.cloudflare.com/library/sandbox:0.13.0-next.1.1',
        'docker:registry.cloudflare.com/library/sandbox:next',
        'npm:@cloudflare/sandbox@0.13.0-next.1.1',
        'npm-dist-tag:next=0.13.0-next.1.1'
      ].sort()
    );
  });
});
