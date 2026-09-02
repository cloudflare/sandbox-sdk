import { describe, expect, it } from 'vitest';
import {
  expandBackupExcludePattern,
  getBackupExcludePatternError
} from '../src/backup';

describe('backup exclude patterns', () => {
  it.each([
    ['node_modules', ['node_modules', '... node_modules']],
    ['node_modules/', ['node_modules', '... node_modules']],
    ['dist', ['dist', '... dist']],
    ['dist/', ['dist', '... dist']],
    ['**/dist', ['dist', '... dist']],
    ['**/dist/', ['dist', '... dist']],
    ['**/dist/**', ['dist', '... dist']],
    ['**/**/cache', ['cache', '... cache']],
    ['dist/**', ['dist']],
    ['foo/**/', ['foo']],
    ['a/b/**/', ['a/b']],
    ['**/x/**/', ['x', '... x']],
    ['packages/app/**', ['packages/app']],
    ['alpha/beta/', ['alpha/beta']],
    ['a/b', ['a/b']],
    ['.cache/foo/*/node_modules', ['.cache/foo/*/node_modules']],
    ['nested/path', ['nested/path']],
    ['nested/path/', ['nested/path']],
    ['*/*', ['*/*']],
    ['a/*', ['a/*']],
    ['?', ['?', '... ?']],
    ['?*?', ['?*?', '... ?*?']],
    ['*.log', ['*.log', '... *.log']],
    ['logs/**.log', ['logs/**.log']],
    ['foo**/bar', ['foo**/bar']],
    ['...foo', ['...foo', '... ...foo']]
  ])(
    'accepts and emits exactly the expected lines for %j',
    (pattern, emitted) => {
      expect(getBackupExcludePatternError(pattern)).toBeUndefined();
      expect(expandBackupExcludePattern(pattern)).toEqual(emitted);
    }
  );

  it.each([
    '',
    '**',
    '**/',
    '*',
    '*/',
    '***',
    '***/',
    '*?',
    '?*',
    '*?*',
    '**?**',
    '**/***',
    '***/**',
    '**/*?/**',
    '**/*',
    '**/*/',
    '*/**',
    '**/*/**',
    '/',
    '/absolute',
    './relative',
    '../parent',
    'nested/./path',
    'nested/../path',
    'nested//path',
    'dist//',
    '**/dist//',
    'a//b',
    ' leading',
    'trailing ',
    '... cache',
    'line\nbreak',
    'delete\u007fme',
    '**/nested/path',
    '**/a/b',
    '**/a/b/',
    '**/packages/app/**',
    'nested/**/path',
    'a/**/b',
    'foo/**/**'
  ])('rejects %j and fails closed during expansion', (pattern) => {
    const reason = getBackupExcludePatternError(pattern);
    expect(reason).toBeDefined();
    expect(() => expandBackupExcludePattern(pattern)).toThrow(
      new TypeError(reason)
    );
  });
});
