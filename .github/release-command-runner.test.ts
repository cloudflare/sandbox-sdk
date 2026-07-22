import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prereleaseReleaseState } from './release-state.ts';
import {
  convergePrereleaseRelease,
  ExecCommandRunner,
  publishNpmWithPreparedPackage,
  verifyPrereleaseRelease,
  type CommandRunner
} from './release-command-runner.ts';

class TestCommandRunner implements CommandRunner {
  readonly commands: string[][] = [];

  constructor(
    private readonly presentRefs: Set<string>,
    private readonly failCommand?: string,
    private readonly publishedVersion?: string
  ) {}

  async exists(ref: string): Promise<boolean> {
    return this.presentRefs.has(ref);
  }

  async text(): Promise<string> {
    return '';
  }

  async run(command: string, args: string[]): Promise<void> {
    this.commands.push([command, ...args]);
    if ([command, ...args].join(' ') === this.failCommand) {
      throw new Error('command failed');
    }
    if (command === 'npm' && args[0] === 'dist-tag') {
      const version = args[2].slice(args[2].lastIndexOf('@') + 1);
      this.presentRefs.add(`npm-dist-tag:${args[3]}=${version}`);
      return;
    }
    if (command === 'npm' && args[0] === 'publish') {
      if (this.publishedVersion !== undefined) {
        this.presentRefs.add(
          `npm:@cloudflare/sandbox@${this.publishedVersion}`
        );
      }
      return;
    }
    if (command === 'crane' && args[0] === 'copy') {
      this.presentRefs.add(`docker:${args[2]}`);
    }
  }
}

describe('ExecCommandRunner', () => {
  test('surfaces unknown ref kinds instead of reporting them missing', async () => {
    const runner = new ExecCommandRunner();
    await assert.rejects(
      runner.exists('bogus:some-value'),
      /Unknown ref kind: bogus/
    );
  });
});

describe('publishNpmWithPreparedPackage', () => {
  test('cleans a prepared package exactly once after publishing', async () => {
    const cleanupCalls: string[] = [];
    const runner = new TestCommandRunner(new Set());
    await publishNpmWithPreparedPackage(
      runner,
      {
        packageName: '@cloudflare/sandbox',
        version: '1.2.3-beta.1',
        packageDir: '/tmp/package',
        tarballPath: '/tmp/package/package.tgz',
        cleanup: async () => cleanupCalls.push('cleanup')
      },
      '@cloudflare/sandbox',
      '1.2.3-beta.1',
      'beta'
    );
    assert.deepEqual(cleanupCalls, ['cleanup']);
    assert.deepEqual(runner.commands, [
      [
        'npm',
        'publish',
        '/tmp/package/package.tgz',
        '--tag',
        'beta',
        '--access',
        'public'
      ]
    ]);
  });

  test('cleans exactly once when publishing fails', async () => {
    const cleanupCalls: string[] = [];
    const runner = new TestCommandRunner(
      new Set(),
      'npm publish /tmp/package/package.tgz --tag beta --access public'
    );
    await assert.rejects(
      publishNpmWithPreparedPackage(
        runner,
        {
          packageName: '@cloudflare/sandbox',
          version: '1.2.3-beta.1',
          packageDir: '/tmp/package',
          tarballPath: '/tmp/package/package.tgz',
          cleanup: async () => cleanupCalls.push('cleanup')
        },
        '@cloudflare/sandbox',
        '1.2.3-beta.1',
        'beta'
      ),
      /command failed/
    );
    assert.deepEqual(cleanupCalls, ['cleanup']);
  });
});

describe('convergePrereleaseRelease', () => {
  test('uses isolated preparation and cleans the package exactly once', async () => {
    const state = prereleaseReleaseState({
      version: '1.2.3-beta.1',
      sourceTag: 'ci-hash',
      npmTag: 'beta',
      images: ['sandbox']
    });
    const cleanupCalls: string[] = [];
    const runner = new TestCommandRunner(
      new Set([
        'docker:docker.io/cloudflare/sandbox:1.2.3-beta.1',
        'docker:registry.cloudflare.com/library/sandbox:1.2.3-beta.1'
      ]),
      undefined,
      '1.2.3-beta.1'
    );

    await convergePrereleaseRelease(state, runner, {
      releaseRoot: '/tmp/release-root',
      cloudflareAccountId: 'cf-account-123',
      prepareNpmPackage: async (input) => {
        assert.deepEqual(input, {
          releaseRoot: '/tmp/release-root',
          packageName: '@cloudflare/sandbox',
          version: '1.2.3-beta.1',
          versionOverride: '1.2.3-beta.1'
        });
        return {
          packageName: '@cloudflare/sandbox',
          version: '1.2.3-beta.1',
          packageDir: '/tmp/package',
          tarballPath: '/tmp/package/package.tgz',
          cleanup: async () => cleanupCalls.push('cleanup')
        };
      }
    });

    assert.deepEqual(runner.commands.slice(0, 2), [
      [
        'npm',
        'publish',
        '/tmp/package/package.tgz',
        '--tag',
        'beta',
        '--access',
        'public'
      ],
      ['npm', 'dist-tag', 'add', '@cloudflare/sandbox@1.2.3-beta.1', 'beta']
    ]);
    assert.deepEqual(cleanupCalls, ['cleanup']);
  });

  test('publishes missing Docker versions and aliases', async () => {
    const state = prereleaseReleaseState({
      version: '0.13.0-next.1.1',
      sourceTag: 'prerelease-next-0.13.0-next.1.1',
      npmTag: 'next',
      dockerAlias: 'next',
      images: ['sandbox']
    });
    const runner = new TestCommandRunner(
      new Set([
        'npm:@cloudflare/sandbox@0.13.0-next.1.1',
        'npm-dist-tag:next=0.13.0-next.1.1'
      ])
    );

    await convergePrereleaseRelease(state, runner, {
      cloudflareAccountId: 'cf-account-123'
    });

    assert.deepEqual(runner.commands, [
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox:prerelease-next-0.13.0-next.1.1',
        'docker.io/cloudflare/sandbox:0.13.0-next.1.1'
      ],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox:prerelease-next-0.13.0-next.1.1',
        'registry.cloudflare.com/library/sandbox:0.13.0-next.1.1'
      ],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox:prerelease-next-0.13.0-next.1.1',
        'docker.io/cloudflare/sandbox:next'
      ],
      [
        'crane',
        'copy',
        'registry.cloudflare.com/cf-account-123/sandbox:prerelease-next-0.13.0-next.1.1',
        'registry.cloudflare.com/library/sandbox:next'
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
    const runner = new TestCommandRunner(
      new Set([
        'npm:@cloudflare/sandbox@0.13.0-next.1.1',
        'npm-dist-tag:next=0.13.0-next.1.1'
      ])
    );
    await assert.rejects(
      convergePrereleaseRelease(state, runner, {
        cloudflareAccountId: ''
      }),
      /CLOUDFLARE_ACCOUNT_ID is required/
    );
    assert.deepEqual(runner.commands, []);
  });
});

describe('verifyPrereleaseRelease', () => {
  test('checks npm dist-tag and Docker aliases with exact refs', async () => {
    const state = prereleaseReleaseState({
      version: '0.13.0-next.1.1',
      sourceTag: 'prerelease-next-0.13.0-next.1.1',
      npmTag: 'next',
      dockerAlias: 'next',
      images: ['sandbox']
    });
    const result = await verifyPrereleaseRelease(
      state,
      new TestCommandRunner(new Set())
    );
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
