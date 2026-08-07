import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeNpmPrepDeps, prepareNpmPackage } from './npm-package-prep.ts';

describe('prepareNpmPackage', () => {
  test('rewrites @repo/shared workspace range only in staged manifest and validates exported pack files', async () => {
    const writes = new Map<string, string>();
    const removed: string[] = [];
    const prepared = await prepareNpmPackage(
      {
        releaseRoot: '/repo/release',
        packageName: '@cloudflare/sandbox',
        version: '1.2.3'
      },
      {
        makeTempDir: () => '/tmp/sandbox-npm-1',
        copyPackage: (from, to) => writes.set('copy', `${from}->${to}`),
        readFile: (path) =>
          path.endsWith('package.json')
            ? '{"name":"@cloudflare/sandbox","version":"1.2.3","dependencies":{"@repo/shared":"workspace:*"},"exports":{".":{"import":"./dist/index.js","types":"./dist/index.d.ts"}}}'
            : 'ok',
        writeFile: (path, content) => writes.set(path, content),
        exists: (path) =>
          path.endsWith('dist/index.js') || path.endsWith('dist/index.d.ts'),
        command: async () => ({
          exitCode: 0,
          stdout:
            '[{"filename":"cloudflare-sandbox-1.2.3.tgz","files":[{"path":"package.json"},{"path":"dist/index.js"},{"path":"dist/index.d.ts"}]}]',
          stderr: ''
        }),
        remove: async (path) => removed.push(path),
        workspaceVersions: () => new Map([['@repo/shared', '1.2.3']])
      }
    );
    assert.equal(prepared.packageName, '@cloudflare/sandbox');
    assert.equal(prepared.version, '1.2.3');
    assert.equal(prepared.packageDir, '/tmp/sandbox-npm-1/package');
    assert.equal(
      prepared.tarballPath,
      join('/tmp/sandbox-npm-1/package', 'cloudflare-sandbox-1.2.3.tgz')
    );
    const stagedManifest =
      writes.get('/tmp/sandbox-npm-1/package/package.json') ?? '';
    assert.match(stagedManifest, /"@repo\/shared": "\^1\.2\.3"/);
    assert.doesNotMatch(stagedManifest, /workspace:|"\*"/);
    await prepared.cleanup();
    await prepared.cleanup();
    assert.deepEqual(removed, ['/tmp/sandbox-npm-1']);
  });

  test('uses versionOverride for prerelease without editing releaseRoot', async () => {
    const writes = new Map<string, string>();
    const prepared = await prepareNpmPackage(
      {
        releaseRoot: '/repo/release',
        packageName: '@cloudflare/sandbox',
        version: '1.2.3',
        versionOverride: '1.2.3-beta.1'
      },
      fakeDeps(writes)
    );
    assert.equal(prepared.packageName, '@cloudflare/sandbox');
    assert.equal(prepared.version, '1.2.3-beta.1');
    assert.match(
      writes.get('/tmp/sandbox-npm-test/package/package.json') ?? '',
      /"version": "1\.2\.3-beta\.1"/
    );
    assert.equal(
      prepared.tarballPath,
      '/tmp/sandbox-npm-test/package/cloudflare-sandbox-1.2.3-beta.1.tgz'
    );
  });

  test('cleans up once when export validation fails', async () => {
    const removed: string[] = [];
    await assert.rejects(
      prepareNpmPackage(
        {
          releaseRoot: '/repo/release',
          packageName: '@cloudflare/sandbox',
          version: '1.2.3'
        },
        {
          ...fakeDeps(new Map()),
          exists: (path) => !path.endsWith('dist/index.d.ts'),
          remove: async (path) => removed.push(path)
        }
      ),
      /Declared export file is missing from staged package: dist\/index\.d\.ts/
    );
    assert.deepEqual(removed, ['/tmp/sandbox-npm-test']);
  });

  test('reads workspace versions when historical root has no shared package', () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), 'sandbox-release-root-'));
    try {
      const sandboxDir = join(releaseRoot, 'packages', 'sandbox');
      mkdirSync(sandboxDir, { recursive: true });
      writeFileSync(
        join(sandboxDir, 'package.json'),
        '{"name":"@cloudflare/sandbox","version":"1.2.3"}'
      );

      assert.deepEqual(
        nodeNpmPrepDeps.workspaceVersions(releaseRoot),
        new Map([['@cloudflare/sandbox', '1.2.3']])
      );
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  test('retries cleanup after removal fails', async () => {
    let attempts = 0;
    const prepared = await prepareNpmPackage(
      {
        releaseRoot: '/repo/release',
        packageName: '@cloudflare/sandbox',
        version: '1.2.3'
      },
      {
        ...fakeDeps(new Map()),
        remove: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('remove failed');
          }
        }
      }
    );

    await assert.rejects(prepared.cleanup(), /remove failed/);
    await prepared.cleanup();
    await prepared.cleanup();
    assert.equal(attempts, 2);
  });
});

function fakeDeps(writes: Map<string, string>) {
  return {
    makeTempDir: () => '/tmp/sandbox-npm-test',
    copyPackage: (from: string, to: string) =>
      writes.set('copy', `${from}->${to}`),
    readFile: (path: string) =>
      path.endsWith('package.json')
        ? '{"name":"@cloudflare/sandbox","version":"1.2.3","dependencies":{"@repo/shared":"workspace:*"},"exports":{".":{"import":"./dist/index.js","types":"./dist/index.d.ts"}}}'
        : 'ok',
    writeFile: (path: string, content: string) => writes.set(path, content),
    exists: (path: string) =>
      path.endsWith('dist/index.js') || path.endsWith('dist/index.d.ts'),
    command: async () => ({
      exitCode: 0,
      stdout:
        '[{"filename":"cloudflare-sandbox-1.2.3-beta.1.tgz","files":[{"path":"package.json"},{"path":"dist/index.js"},{"path":"dist/index.d.ts"}]}]',
      stderr: ''
    }),
    remove: async () => undefined,
    workspaceVersions: () => new Map([['@repo/shared', '1.2.3']])
  };
}

import { parseNpmPackResult } from './npm-package-prep.ts';

describe('parseNpmPackResult', () => {
  test('accepts array and single-object npm pack JSON', () => {
    assert.equal(
      parseNpmPackResult(
        '[{"filename":"pkg.tgz","files":[{"path":"package.json"}]}]'
      ).filename,
      'pkg.tgz'
    );
    assert.equal(
      parseNpmPackResult(
        '{"filename":"pkg.tgz","files":[{"path":"package.json"}]}'
      ).filename,
      'pkg.tgz'
    );
  });

  test('ignores leading npm notices before JSON', () => {
    assert.equal(
      parseNpmPackResult(
        'npm notice\n[{"filename":"pkg.tgz","files":[{"path":"package.json"}]}]'
      ).filename,
      'pkg.tgz'
    );
  });

  test('accepts package-name keyed npm pack JSON', () => {
    assert.equal(
      parseNpmPackResult(
        '{"@cloudflare/sandbox":{"filename":"cloudflare-sandbox-0.12.5.tgz","files":[{"path":"package.json"}]}}'
      ).filename,
      'cloudflare-sandbox-0.12.5.tgz'
    );
  });
});
