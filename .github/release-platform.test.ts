import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { commitSHA, stableVersion, versionTag } from './release-primitives.ts';
import { ExecReleasePlatform } from './release-platform.ts';
import { FakeReleasePlatform } from './test/release-platform-fake.ts';

describe('ReleasePlatform', () => {
  test('fake apply methods mutate observed maps for reinspection', async () => {
    const platform = new FakeReleasePlatform();
    const tag = versionTag('@cloudflare/sandbox@1.2.3');
    const sha = commitSHA('0123456789abcdef0123456789abcdef01234567');
    await platform.git.createTag(tag, sha);
    await platform.npm.publishPreparedPackage(
      {
        packageName: '@cloudflare/sandbox',
        version: '1.2.3',
        packageDir: '/tmp/pkg',
        tarballPath: '/tmp/pkg/pkg.tgz',
        cleanup: async () => undefined
      },
      'latest'
    );
    assert.equal(await platform.git.resolveTag(tag), sha);
    assert.deepEqual(
      await platform.npm.inspectVersion(
        '@cloudflare/sandbox',
        stableVersion('1.2.3')
      ),
      { version: stableVersion('1.2.3') }
    );
    assert.equal(
      await platform.npm.inspectDistTag('@cloudflare/sandbox', 'latest'),
      stableVersion('1.2.3')
    );
  });

  test('exec git resolves authoritative remote tags and peels annotated tags', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const platform = new ExecReleasePlatform({
      command: async (command, args) => {
        calls.push({ command, args });
        return {
          exitCode: 0,
          stdout: [
            '1111111111111111111111111111111111111111\trefs/tags/@cloudflare/sandbox@1.2.3',
            '0123456789abcdef0123456789abcdef01234567\trefs/tags/@cloudflare/sandbox@1.2.3^{}'
          ].join('\n'),
          stderr: ''
        };
      }
    });

    assert.equal(
      await platform.git.resolveTag(versionTag('@cloudflare/sandbox@1.2.3')),
      commitSHA('0123456789abcdef0123456789abcdef01234567')
    );
    assert.deepEqual(calls, [
      {
        command: 'git',
        args: [
          'ls-remote',
          '--tags',
          'origin',
          'refs/tags/@cloudflare/sandbox@1.2.3',
          'refs/tags/@cloudflare/sandbox@1.2.3^{}'
        ]
      }
    ]);
  });

  test('exec git distinguishes absent remote tags from operational failures', async () => {
    const absent = new ExecReleasePlatform({
      command: async () => ({ exitCode: 0, stdout: '', stderr: '' })
    });
    assert.equal(
      await absent.git.resolveTag(versionTag('@cloudflare/sandbox@1.2.3')),
      undefined
    );

    const failed = new ExecReleasePlatform({
      command: async () => ({
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: could not read from remote repository'
      })
    });
    await assert.rejects(
      failed.git.resolveTag(versionTag('@cloudflare/sandbox@1.2.3')),
      /git resolve tag @cloudflare\/sandbox@1\.2\.3 failed: fatal: could not read from remote repository/
    );
  });

  test('exec npm publishes scoped packages with public access', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const platform = new ExecReleasePlatform({
      command: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    await platform.npm.publishPreparedPackage(
      {
        packageName: '@cloudflare/sandbox',
        version: '1.2.3',
        packageDir: '/tmp/pkg',
        tarballPath: '/tmp/pkg/pkg.tgz',
        cleanup: async () => undefined
      },
      'latest'
    );
    assert.deepEqual(calls, [
      {
        command: 'npm',
        args: [
          'publish',
          '/tmp/pkg/pkg.tgz',
          '--access',
          'public',
          '--tag',
          'latest'
        ]
      }
    ]);
  });

  test('exec npm inspections bypass cached registry metadata', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const platform = new ExecReleasePlatform({
      command: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: '"1.2.3"', stderr: '' };
      }
    });

    await platform.npm.inspectVersion(
      '@cloudflare/sandbox',
      stableVersion('1.2.3')
    );
    await platform.npm.inspectDistTag('@cloudflare/sandbox', 'latest');

    assert.deepEqual(calls, [
      {
        command: 'npm',
        args: [
          'view',
          '@cloudflare/sandbox@1.2.3',
          'version',
          '--json',
          '--prefer-online'
        ]
      },
      {
        command: 'npm',
        args: [
          'view',
          '@cloudflare/sandbox',
          'dist-tags.latest',
          '--json',
          '--prefer-online'
        ]
      }
    ]);
  });

  test('exec npm inspection returns missing for E404 and throws for auth', async () => {
    const missing = new ExecReleasePlatform({
      command: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'npm ERR! code E404'
      })
    });
    assert.equal(
      await missing.npm.inspectVersion(
        '@cloudflare/sandbox',
        stableVersion('1.2.3')
      ),
      undefined
    );
    const auth = new ExecReleasePlatform({
      command: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'npm ERR! code E401'
      })
    });
    await assert.rejects(
      auth.npm.inspectVersion('@cloudflare/sandbox', stableVersion('1.2.3')),
      /npm inspect failed for @cloudflare\/sandbox@1\.2\.3: npm ERR! code E401/
    );
  });

  test('exec clients distinguish absent remote state from operational errors', async () => {
    const absent = new ExecReleasePlatform({
      command: async (command) => ({
        exitCode: 1,
        stdout: '',
        stderr:
          command === 'gh'
            ? 'HTTP 404: release not found'
            : 'MANIFEST_UNKNOWN: manifest unknown'
      })
    });
    assert.equal(
      await absent.github.inspectRelease(
        versionTag('@cloudflare/sandbox@1.2.3')
      ),
      undefined
    );
    assert.equal(
      await absent.docker.resolveDigest({
        repository: 'registry.example/sandbox',
        tag: '1.2.3'
      }),
      undefined
    );

    const denied = new ExecReleasePlatform({
      command: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'permission denied'
      })
    });
    await assert.rejects(
      denied.github.inspectRelease(versionTag('@cloudflare/sandbox@1.2.3')),
      /github inspect release .* failed: permission denied/
    );
    await assert.rejects(
      denied.docker.resolveDigest({
        repository: 'registry.example/sandbox',
        tag: '1.2.3'
      }),
      /docker inspect .* failed: permission denied/
    );
  });

  test('npm inspectVersion accepts object and bare version JSON shapes', async () => {
    const objectShape = new ExecReleasePlatform({
      command: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ version: '1.2.3' }),
        stderr: ''
      })
    });
    assert.deepEqual(
      await objectShape.npm.inspectVersion(
        '@cloudflare/sandbox',
        stableVersion('1.2.3')
      ),
      { version: stableVersion('1.2.3') }
    );

    const bare = new ExecReleasePlatform({
      command: async () => ({
        exitCode: 0,
        stdout: '1.2.3\n',
        stderr: ''
      })
    });
    assert.deepEqual(
      await bare.npm.inspectVersion(
        '@cloudflare/sandbox',
        stableVersion('1.2.3')
      ),
      { version: stableVersion('1.2.3') }
    );

    const arrayShape = new ExecReleasePlatform({
      command: async () => ({
        exitCode: 0,
        stdout: '["1.2.3"]\n',
        stderr: ''
      })
    });
    assert.deepEqual(
      await arrayShape.npm.inspectVersion(
        '@cloudflare/sandbox',
        stableVersion('1.2.3')
      ),
      { version: stableVersion('1.2.3') }
    );
  });
});
