import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStablePlanIncomplete,
  parseCliArgs
} from './release-orchestrator.ts';

describe('parseCliArgs', () => {
  test('parses stable args with release root', () => {
    assert.deepEqual(
      parseCliArgs([
        'stable',
        '--version',
        '1.2.3',
        '--source-tag',
        'ci-abc',
        '--commit-sha',
        '0123456789abcdef0123456789abcdef01234567',
        '--release-root',
        '/tmp/release-root',
        '--mode',
        'current'
      ]),
      {
        command: 'stable',
        version: '1.2.3',
        sourceTag: 'ci-abc',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        releaseRoot: '/tmp/release-root',
        mode: 'current'
      }
    );
  });

  test('parses inspect-stable without mutation flags', () => {
    assert.deepEqual(
      parseCliArgs([
        'inspect-stable',
        '--version',
        '1.2.3',
        '--source-tag',
        'ci-abc',
        '--commit-sha',
        '0123456789abcdef0123456789abcdef01234567',
        '--release-root',
        '/tmp/release-root',
        '--mode',
        'current'
      ]),
      {
        command: 'inspect-stable',
        version: '1.2.3',
        sourceTag: 'ci-abc',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        releaseRoot: '/tmp/release-root',
        mode: 'current'
      }
    );
  });

  test('parses prerelease args with release root', () => {
    assert.deepEqual(
      parseCliArgs([
        'prerelease',
        '--version',
        '1.2.3-beta.1',
        '--source-tag',
        'ci-abc',
        '--npm-tag',
        'beta',
        '--release-root',
        '/tmp/release-root'
      ]),
      {
        command: 'prerelease',
        version: '1.2.3-beta.1',
        sourceTag: 'ci-abc',
        npmTag: 'beta',
        dockerAlias: undefined,
        releaseRoot: '/tmp/release-root'
      }
    );
  });

  test('rejects unknown and command-inapplicable stable options', () => {
    const base = [
      'stable',
      '--version',
      '1.2.3',
      '--source-tag',
      'ci-abc',
      '--commit-sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--mode',
      'current'
    ];
    assert.throws(
      () => parseCliArgs([...base, '--skip-npm', 'true']),
      /Option --skip-npm is not valid for stable/
    );
    assert.throws(
      () => parseCliArgs([...base, '--unknown', 'value']),
      /Option --unknown is not valid for stable/
    );
  });

  test('rejects prerelease-only options on inspect-stable', () => {
    assert.throws(
      () =>
        parseCliArgs([
          'inspect-stable',
          '--version',
          '1.2.3',
          '--source-tag',
          'ci-abc',
          '--commit-sha',
          '0123456789abcdef0123456789abcdef01234567',
          '--mode',
          'current',
          '--npm-tag',
          'beta'
        ]),
      /Option --npm-tag is not valid for inspect-stable/
    );
  });
});

describe('isStablePlanIncomplete', () => {
  test('treats missing operations or conflicts as incomplete', () => {
    assert.equal(
      isStablePlanIncomplete({
        operations: [{ type: 'missing' }],
        conflicts: []
      }),
      true
    );
    assert.equal(
      isStablePlanIncomplete({ operations: [], conflicts: ['wrong digest'] }),
      true
    );
    assert.equal(
      isStablePlanIncomplete({ operations: [], conflicts: [] }),
      false
    );
  });
});
