import { describe, expect, it } from 'vitest';
import { validateBackupExcludes } from '../src/backup/validation';
import { InvalidBackupConfigError } from '../src/errors';

const validPatterns = [
  'node_modules',
  'node_modules/',
  'dist',
  'dist/',
  '**/dist',
  '**/dist/',
  '**/dist/**',
  '**/**/cache',
  'dist/**',
  'foo/**/',
  'a/b/**/',
  '**/x/**/',
  'packages/app/**',
  'alpha/beta/',
  'a/b',
  '.cache/foo/*/node_modules',
  'nested/path',
  'nested/path/',
  '*/*',
  'a/*',
  '?',
  '?*?',
  '*.log',
  'logs/**.log',
  'foo**/bar',
  '...foo'
];

const invalidPatterns = [
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
];

describe('backup exclude validation', () => {
  it.each(validPatterns)('accepts %j', (pattern) => {
    expect(() => validateBackupExcludes([pattern])).not.toThrow();
  });

  it.each(invalidPatterns)('rejects %j', (pattern) => {
    expect(() => validateBackupExcludes([pattern])).toThrow(
      InvalidBackupConfigError
    );
  });
});
