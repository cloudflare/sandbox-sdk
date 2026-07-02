import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractChangelogSection,
  loadDockerImages,
  prereleaseReleaseState,
  publicDockerTags,
  stableReleaseState
} from './release-state.ts';

describe('publicDockerTags', () => {
  test('maps internal sandbox images to public version tags', () => {
    const mappings = publicDockerTags('0.12.2', [
      'sandbox',
      'sandbox-python',
      'sandbox-opencode',
      'sandbox-musl',
      'sandbox-standalone'
    ]);

    assert.deepEqual(
      mappings.map((mapping) => ({ image: mapping.image, tag: mapping.tag })),
      [
        { image: 'sandbox', tag: '0.12.2' },
        { image: 'sandbox-python', tag: '0.12.2-python' },
        { image: 'sandbox-opencode', tag: '0.12.2-opencode' },
        { image: 'sandbox-musl', tag: '0.12.2-musl' }
      ]
    );
  });

  test('adds alias tags for mutable prerelease channels', () => {
    const mappings = publicDockerTags(
      '0.13.0-next.1.1',
      ['sandbox', 'sandbox-musl'],
      'next'
    );

    assert.deepEqual(
      mappings.map((mapping) => ({
        image: mapping.image,
        tag: mapping.tag,
        alias: mapping.aliasTag
      })),
      [
        { image: 'sandbox', tag: '0.13.0-next.1.1', alias: 'next' },
        {
          image: 'sandbox-musl',
          tag: '0.13.0-next.1.1-musl',
          alias: 'next-musl'
        }
      ]
    );
  });

  test('rejects invalid image names', () => {
    assert.throws(
      () => publicDockerTags('0.12.2', ['sandbox', 'not-sandbox']),
      /Invalid image name: not-sandbox/
    );
  });
});

function withDockerImagesFile(
  content: string,
  callback: (root: string) => void
) {
  const root = mkdtempSync(join(tmpdir(), 'release-state-'));

  try {
    writeFileSync(join(root, 'docker-images.txt'), content);
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('loadDockerImages', () => {
  test('loads image names while ignoring comments and blank lines', () => {
    withDockerImagesFile(
      '# generated list\n\nsandbox\r\n  sandbox-python  \n# skip me\nsandbox-musl\n',
      (root) => {
        assert.deepEqual(loadDockerImages(root), [
          'sandbox',
          'sandbox-python',
          'sandbox-musl'
        ]);
      }
    );
  });

  test('rejects invalid image names', () => {
    withDockerImagesFile('sandbox\nsandbox_bad\n', (root) => {
      assert.throws(
        () => loadDockerImages(root),
        /Invalid image name in docker-images.txt: sandbox_bad/
      );
    });
  });

  test('rejects files with no image names', () => {
    withDockerImagesFile('\n# no images\n  \n', (root) => {
      assert.throws(
        () => loadDockerImages(root),
        /No images found in docker-images.txt/
      );
    });
  });
});

describe('extractChangelogSection', () => {
  test('extracts a single stable version body', () => {
    const changelog = `# @cloudflare/sandbox\n\n## 0.12.2\n\n### Patch Changes\n\n- Fix thing\n\n## 0.12.1\n\n- Previous\n`;

    assert.equal(
      extractChangelogSection(changelog, '0.12.2'),
      '### Patch Changes\n\n- Fix thing'
    );
  });

  test('matches complete version headings only', () => {
    const changelog = `# @cloudflare/sandbox\n\n## 0.12.20\n\n- Wrong version\n\n## 0.12.2\n\n- Right version\n`;

    assert.equal(
      extractChangelogSection(changelog, '0.12.2'),
      '- Right version'
    );
  });
});

describe('stableReleaseState', () => {
  test('constructs stable desired state', () => {
    const state = stableReleaseState({
      version: '0.12.2',
      sourceTag: 'ci-hash',
      commitSha: 'abc123',
      images: ['sandbox', 'sandbox-musl'],
      changelogBody: '### Patch Changes\n\n- Fix thing'
    });

    assert.equal(state.npmPackage, '@cloudflare/sandbox');
    assert.equal(state.version, '0.12.2');
    assert.equal(state.gitTag, '@cloudflare/sandbox@0.12.2');
    assert.equal(state.npmTag, 'latest');
    assert.deepEqual(state.releaseAssets, [
      'sandbox-linux-x64',
      'sandbox-linux-x64.sha256',
      'sandbox-linux-x64-musl',
      'sandbox-linux-x64-musl.sha256'
    ]);
  });
});

describe('prereleaseReleaseState', () => {
  test('constructs prerelease desired state with source refs and aliases', () => {
    const state = prereleaseReleaseState({
      version: '0.13.0-next.1.1',
      sourceTag: 'ci-hash',
      npmTag: 'next',
      dockerAlias: 'next',
      images: ['sandbox', 'sandbox-musl', 'sandbox-standalone']
    });

    assert.equal(state.mode, 'prerelease');
    assert.equal(state.npmPackage, '@cloudflare/sandbox');
    assert.equal(state.version, '0.13.0-next.1.1');
    assert.equal(state.sourceTag, 'ci-hash');
    assert.equal(state.npmTag, 'next');
    assert.equal(state.dockerAlias, 'next');
    assert.deepEqual(
      state.dockerTags.map((mapping) => ({
        image: mapping.image,
        sourceTag: mapping.sourceTag,
        tag: mapping.tag,
        aliasTag: mapping.aliasTag,
        sourceRef: mapping.sourceRef
      })),
      [
        {
          image: 'sandbox',
          sourceTag: 'ci-hash',
          tag: '0.13.0-next.1.1',
          aliasTag: 'next',
          sourceRef:
            'registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox:ci-hash'
        },
        {
          image: 'sandbox-musl',
          sourceTag: 'ci-hash',
          tag: '0.13.0-next.1.1-musl',
          aliasTag: 'next-musl',
          sourceRef:
            'registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox-musl:ci-hash'
        }
      ]
    );
  });
});
