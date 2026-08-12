import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishPreviewPackage } from './publish-preview-package.ts';

test('publishes an isolated preview package and always cleans it', async () => {
  const events: string[] = [];

  await publishPreviewPackage(
    { releaseRoot: '/repo', versionOverride: '0.0.0-pr-123-abc' },
    {
      readFile: () => '{"name":"@cloudflare/sandbox","version":"1.2.3"}',
      prepareNpmPackage: async (input) => {
        assert.deepEqual(input, {
          releaseRoot: '/repo',
          packageName: '@cloudflare/sandbox',
          version: '1.2.3',
          versionOverride: '0.0.0-pr-123-abc'
        });
        return {
          packageName: '@cloudflare/sandbox',
          version: '0.0.0-pr-123-abc',
          packageDir: '/tmp/package',
          tarballPath: '/tmp/package/package.tgz',
          cleanup: async () => {
            events.push('cleanup');
          }
        };
      },
      publish: async (packageDir) => {
        events.push(`publish:${packageDir}`);
      }
    }
  );

  assert.deepEqual(events, ['publish:/tmp/package', 'cleanup']);
});

test('cleans the isolated package when preview publication fails', async () => {
  const events: string[] = [];

  await assert.rejects(
    publishPreviewPackage(
      { releaseRoot: '/repo', versionOverride: '0.0.0-pr-123-abc' },
      {
        readFile: () => '{"name":"@cloudflare/sandbox","version":"1.2.3"}',
        prepareNpmPackage: async () => ({
          packageName: '@cloudflare/sandbox',
          version: '0.0.0-pr-123-abc',
          packageDir: '/tmp/package',
          tarballPath: '/tmp/package/package.tgz',
          cleanup: async () => {
            events.push('cleanup');
          }
        }),
        publish: async () => {
          throw new Error('publish failed');
        }
      }
    ),
    /publish failed/
  );

  assert.deepEqual(events, ['cleanup']);
});
