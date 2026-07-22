import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStableReleaseContext } from './stable-release-context.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = '89abcdef0123456789abcdef0123456789abcdef';

function deps(files: Map<string, string>, head = SHA) {
  return {
    readFile: (path: string) =>
      files.get(path) ?? assert.fail(`unexpected read ${path}`),
    commandText: async (
      _command: string,
      _args: readonly string[],
      options: { cwd: string }
    ) => {
      assert.equal(options.cwd, '/tmp/release-root');
      return `${head}\n`;
    }
  };
}

describe('createStableReleaseContext', () => {
  test('rejects a release root at a different commit before reading files', async () => {
    const files = new Map<string, string>();

    await assert.rejects(
      createStableReleaseContext(
        {
          version: '1.2.3',
          releaseSHA: SHA,
          releaseRoot: '/tmp/release-root',
          sourceTag: 'ci-abc',
          mode: 'historical'
        },
        deps(files, OTHER_SHA)
      ),
      new RegExp(
        `releaseRoot HEAD ${OTHER_SHA} does not match releaseSHA ${SHA}`
      )
    );
  });

  test('reads all release-owned inputs from releaseRoot', async () => {
    const root = '/tmp/release-root';
    const files = new Map<string, string>([
      [
        join(root, 'packages/sandbox/package.json'),
        '{"name":"@cloudflare/sandbox","version":"1.2.3"}'
      ],
      [
        join(root, 'packages/sandbox/CHANGELOG.md'),
        '## 1.2.3\n\n- Fixed release'
      ],
      [join(root, 'docker-images.txt'), 'sandbox\nsandbox-musl\n']
    ]);
    const context = await createStableReleaseContext(
      {
        version: '1.2.3',
        releaseSHA: SHA,
        releaseRoot: root,
        sourceTag: 'ci-abc',
        mode: 'current'
      },
      deps(files)
    );
    assert.equal(context.releaseRoot, root);
    assert.equal(context.releaseSHA, SHA);
    assert.deepEqual(
      context.dockerImages.map((image) => image.image),
      ['sandbox', 'sandbox-musl']
    );
    assert.equal(context.changelogBody, '- Fixed release');
  });

  test('rejects package version mismatch before inspection', async () => {
    const root = '/tmp/release-root';
    const files = new Map<string, string>([
      [
        join(root, 'packages/sandbox/package.json'),
        '{"name":"@cloudflare/sandbox","version":"1.2.4"}'
      ],
      [
        join(root, 'packages/sandbox/CHANGELOG.md'),
        '## 1.2.3\n\n- Fixed release'
      ],
      [join(root, 'docker-images.txt'), 'sandbox\n']
    ]);
    await assert.rejects(
      createStableReleaseContext(
        {
          version: '1.2.3',
          releaseSHA: SHA,
          releaseRoot: root,
          sourceTag: 'ci-abc',
          mode: 'current'
        },
        deps(files)
      ),
      /Release root package version 1\.2\.4 does not match requested 1\.2\.3/
    );
  });
});
