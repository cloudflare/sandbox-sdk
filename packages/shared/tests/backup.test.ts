import { describe, expect, it } from 'vitest';
import {
  expandBackupExcludePattern,
  getBackupExcludePatternError
} from '../src/backup';

describe('backup exclude patterns', () => {
  it.each([
    ['node_modules', ['node_modules', '... node_modules']],
    ['node_modules/', ['node_modules', '... node_modules']],
    ['nested/path', ['nested/path']],
    ['nested/path/', ['nested/path']],
    ['packages/foo/node_modules/', ['packages/foo/node_modules']],
    ['alpha/beta', ['alpha/beta']],
    ['alpha/beta/', ['alpha/beta']],
    ['dist', ['dist', '... dist']],
    ['dist/', ['dist', '... dist']],
    ['dist/**', ['dist']],
    ['packages/app/**', ['packages/app']],
    ['**/tree/**', ['tree', '... tree']],
    ['**/dist', ['dist', '... dist']],
    ['**/dist/**', ['dist', '... dist']],
    ['**/dist/', ['dist', '... dist']],
    ['**/**/cache', ['cache', '... cache']],
    ['a/b', ['a/b']],
    ['.cache/foo/*/node_modules', ['.cache/foo/*/node_modules']],
    ['*/*', ['*/*']],
    ['a/*', ['a/*']],
    ['?', ['?', '... ?']],
    ['?*?', ['?*?', '... ?*?']],
    ['*.log', ['*.log', '... *.log']],
    ['logs/**.log', ['logs/**.log']],
    ['foo**/bar', ['foo**/bar']],
    ['...foo', ['...foo', '... ...foo']]
  ])('accepts and expands %j', (pattern, mksquashfsPatterns) => {
    expect(getBackupExcludePatternError(pattern as string)).toBeUndefined();
    expect(expandBackupExcludePattern(pattern as string)).toEqual(
      mksquashfsPatterns
    );
  });

  it.each([
    '',
    '**',
    '**/',
    '/',
    '/absolute',
    './relative',
    '../parent',
    'nested/./path',
    'nested/../path',
    'nested//path',
    'dist//',
    '**/dist//',
    ' leading',
    'trailing ',
    '... cache',
    'line\nbreak',
    '**/nested/path',
    '**/a/b/',
    '**/packages/app/**',
    'nested/**/path',
    'foo/**/**'
  ])('rejects non-canonical or unsafe pattern %j', (pattern) => {
    expect(getBackupExcludePatternError(pattern)).toBeDefined();
    expect(() => expandBackupExcludePattern(pattern)).toThrow(
      'Invalid backup exclude pattern'
    );
  });

  it('never emits a match-all or separator-bearing sticky pattern', () => {
    for (const pattern of [
      'node_modules',
      'dist',
      'dist/',
      'node_modules/',
      '**/dist',
      '**/dist/',
      'dist/**',
      'packages/app/**',
      'alpha/beta/',
      'nested/path/',
      'packages/foo/node_modules/',
      'a/b',
      '.cache/foo/*/node_modules',
      '**/dist/**',
      '**/**/cache',
      '*/*',
      'a/*',
      '?',
      '?*?',
      '*.log',
      'logs/**.log',
      'foo**/bar',
      '...foo'
    ]) {
      const emitted = expandBackupExcludePattern(pattern);
      expect(emitted).not.toEqual(['*', '... *']);
      for (const entry of emitted) {
        if (entry.startsWith('... ')) {
          expect(entry).not.toContain('/');
        }
      }
    }
  });

  it('throws the validation reason when expansion receives invalid input', () => {
    expect(() => expandBackupExcludePattern('dist//')).toThrow(
      new TypeError(
        "Invalid backup exclude pattern: patterns must not contain empty, '.', or '..' path components"
      )
    );
  });

  it.each([
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
    '**/*/**'
  ])(
    'rejects match-all pattern %j to prevent an effectively empty backup',
    (pattern) => {
      expect(getBackupExcludePatternError(pattern)).toBe(
        'patterns must not match the entire backup'
      );
      expect(() => expandBackupExcludePattern(pattern)).toThrow(
        'Invalid backup exclude pattern'
      );
    }
  );
});
