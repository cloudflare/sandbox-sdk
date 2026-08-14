import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseReleaseIdentity,
  deriveStableReleaseIdentity,
  npmVersionViewArgs,
  runStableIdentityCli,
  type StableIdentityDeps
} from './release-identity.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const HISTORICAL_SHA = '89abcdef0123456789abcdef0123456789abcdef';

test('npm identity lookup bypasses cached registry metadata', () => {
  assert.deepEqual(npmVersionViewArgs('@cloudflare/sandbox@1.2.3'), [
    'view',
    '@cloudflare/sandbox@1.2.3',
    'version',
    '--prefer-online'
  ]);
});

function fakeIdentityDeps(): StableIdentityDeps {
  return {
    resolveRef: async () => SHA,
    tagSHA: async () => undefined,
    npmVersionExists: async () => false,
    currentMainSHA: async () => SHA,
    deriveSourceTag: async () => 'ci-current'
  };
}

test('stable identity CLI prints release outputs', async () => {
  const outputs = await runStableIdentityCli(
    ['stable', '--version', '1.2.3', '--selector', 'main'],
    fakeIdentityDeps()
  );
  assert.match(outputs, /release-sha=0123456789abcdef0123456789abcdef01234567/);
  assert.match(outputs, /release-mode=current/);
  assert.doesNotMatch(outputs, /source-tag=/);
});

test('stable identity CLI rejects unknown options', async () => {
  await assert.rejects(
    runStableIdentityCli(
      [
        'stable',
        '--version',
        '1.2.3',
        '--selector',
        'main',
        '--skip-npm',
        'true'
      ],
      fakeIdentityDeps()
    ),
    /Unknown identity option: --skip-npm/
  );
});

test('stable identity CLI rejects misspelled options', async () => {
  await assert.rejects(
    runStableIdentityCli(
      ['stable', '--version', '1.2.3', '--selecter', 'main'],
      fakeIdentityDeps()
    ),
    /Unknown identity option: --selecter/
  );
});

test('uses an existing version tag as the authoritative identity', async () => {
  const identity = await deriveStableReleaseIdentity(
    { version: '1.2.3', selector: 'main', triggerSHA: SHA },
    {
      resolveRef: async () => assert.fail('selector must not override the tag'),
      tagSHA: async () => HISTORICAL_SHA,
      npmVersionExists: async () =>
        assert.fail('npm ambiguity is irrelevant when the tag exists'),
      currentMainSHA: async () => SHA,
      deriveSourceTag: async (releaseSHA) => {
        assert.equal(releaseSHA, HISTORICAL_SHA);
        return 'ci-historical';
      }
    }
  );

  assert.equal(identity.releaseSHA, HISTORICAL_SHA);
  assert.equal(identity.mode, 'historical');
  assert.equal(identity.sourceTag, 'ci-historical');
});

test('uses the trigger SHA when the version has no tag or npm package', async () => {
  const identity = await deriveStableReleaseIdentity(
    { version: '1.2.3', selector: 'main', triggerSHA: SHA },
    {
      resolveRef: async () =>
        assert.fail('selector must not replace trigger SHA'),
      tagSHA: async () => undefined,
      npmVersionExists: async () => false,
      currentMainSHA: async () => SHA,
      deriveSourceTag: async () => 'ci-current'
    }
  );

  assert.equal(identity.releaseSHA, SHA);
  assert.equal(identity.mode, 'current');
});

test('rejects npm version without version tag as ambiguous identity', async () => {
  await assert.rejects(
    deriveStableReleaseIdentity(
      { version: '1.2.3', selector: 'main', triggerSHA: SHA },
      {
        resolveRef: async () => SHA,
        tagSHA: async () => undefined,
        npmVersionExists: async () => true,
        currentMainSHA: async () => SHA,
        deriveSourceTag: async () => 'ci-abc'
      }
    ),
    /npm has @cloudflare\/sandbox@1\.2\.3 but @cloudflare\/sandbox@1\.2\.3 tag is missing/
  );
});

describe('chooseReleaseIdentity', () => {
  test('uses github sha when no tag and version unpublished', () => {
    assert.deepEqual(
      chooseReleaseIdentity({
        version: '0.12.5',
        tagSHA: null,
        npmVersionExists: false,
        githubSHA: 'abc123'
      }),
      { version: '0.12.5', releaseSHA: 'abc123', recovered: false }
    );
  });

  test('recovers an earlier tagged commit', () => {
    assert.deepEqual(
      chooseReleaseIdentity({
        version: '0.12.5',
        tagSHA: 'old456',
        npmVersionExists: true,
        githubSHA: 'new789'
      }),
      { version: '0.12.5', releaseSHA: 'old456', recovered: true }
    );
  });

  test('tag at the current commit is not flagged as recovery', () => {
    const result = chooseReleaseIdentity({
      version: '0.12.5',
      tagSHA: 'same999',
      npmVersionExists: false,
      githubSHA: 'same999'
    });
    assert.equal(result.recovered, false);
    assert.equal(result.releaseSHA, 'same999');
  });

  test('refuses when npm has the version but the tag is missing', () => {
    assert.throws(
      () =>
        chooseReleaseIdentity({
          version: '0.12.5',
          tagSHA: null,
          npmVersionExists: true,
          githubSHA: 'abc123'
        }),
      /npm already publishes this version but its git tag is missing/
    );
  });

  test('rejects a malformed version', () => {
    assert.throws(
      () =>
        chooseReleaseIdentity({
          version: 'v0.12',
          tagSHA: null,
          npmVersionExists: false,
          githubSHA: 'abc123'
        }),
      /Malformed release version: v0\.12/
    );
  });

  test('rejects an empty resolved sha', () => {
    assert.throws(
      () =>
        chooseReleaseIdentity({
          version: '0.12.5',
          tagSHA: '   ',
          npmVersionExists: false,
          githubSHA: ''
        }),
      /Release commit sha is empty/
    );
  });
});
