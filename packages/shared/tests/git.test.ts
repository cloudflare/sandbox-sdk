import { describe, expect, it } from 'vitest';
import { redactCredentials, sanitizeGitData } from '../src/git';

describe('redactCredentials', () => {
  it('should redact credentials from URLs embedded in text', () => {
    expect(redactCredentials('fatal: https://oauth2:token@github.com/repo.git')).toBe(
      'fatal: https://******@github.com/repo.git'
    );
    expect(redactCredentials('https://user:pass@example.com/path')).toBe(
      'https://******@example.com/path'
    );
    expect(redactCredentials('https://github.com/public.git')).toBe(
      'https://github.com/public.git'
    );
  });
});

describe('sanitizeGitData', () => {
  it('should recursively sanitize credentials in any field', () => {
    const data = {
      repoUrl: 'https://token@github.com/repo.git',
      stderr: 'fatal: https://user:pass@gitlab.com/project.git',
      customField: { nested: 'Error: https://oauth2:token@example.com/path' },
      urls: ['https://ghp_abc@github.com/private.git', 'https://github.com/public.git'],
      exitCode: 128
    };

    const sanitized = sanitizeGitData(data);

    expect(sanitized.repoUrl).toBe('https://******@github.com/repo.git');
    expect(sanitized.stderr).toBe('fatal: https://******@gitlab.com/project.git');
    expect(sanitized.customField.nested).toBe('Error: https://******@example.com/path');
    expect(sanitized.urls[0]).toBe('https://******@github.com/private.git');
    expect(sanitized.urls[1]).toBe('https://github.com/public.git');
    expect(sanitized.exitCode).toBe(128);
  });

  it('should handle edge cases', () => {
    expect(sanitizeGitData(null)).toBe(null);
    expect(sanitizeGitData(undefined)).toBe(undefined);
    expect(sanitizeGitData('https://token@github.com/repo.git')).toBe('https://******@github.com/repo.git');
  });
});
