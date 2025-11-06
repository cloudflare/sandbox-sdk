import { describe, expect, it, vi } from 'vitest';
import { redactCredentials, sanitizeGitData, GitLogger } from '../src/git';
import { createNoOpLogger } from '../src/logger';

describe('redactCredentials', () => {
  it('should redact credentials from URLs embedded in text', () => {
    expect(
      redactCredentials('fatal: https://oauth2:token@github.com/repo.git')
    ).toBe('fatal: https://******@github.com/repo.git');
    expect(redactCredentials('https://user:pass@example.com/path')).toBe(
      'https://******@example.com/path'
    );
    expect(redactCredentials('https://github.com/public.git')).toBe(
      'https://github.com/public.git'
    );
  });

  it('should handle multiple URLs in a single string', () => {
    expect(
      redactCredentials(
        'Error: https://token1@host1.com failed, tried https://token2@host2.com'
      )
    ).toBe(
      'Error: https://******@host1.com failed, tried https://******@host2.com'
    );
  });

  it('should handle URLs in structured formats', () => {
    expect(
      redactCredentials('{"url":"https://token@github.com/repo.git"}')
    ).toBe('{"url":"https://******@github.com/repo.git"}');
    expect(
      redactCredentials('<url>https://token@github.com/repo.git</url>')
    ).toBe('<url>https://******@github.com/repo.git</url>');
  });
});

describe('sanitizeGitData', () => {
  it('should recursively sanitize credentials in any field', () => {
    const data = {
      repoUrl: 'https://token@github.com/repo.git',
      stderr: 'fatal: https://user:pass@gitlab.com/project.git',
      customField: { nested: 'Error: https://oauth2:token@example.com/path' },
      urls: [
        'https://ghp_abc@github.com/private.git',
        'https://github.com/public.git'
      ],
      exitCode: 128
    };

    const sanitized = sanitizeGitData(data);

    expect(sanitized.repoUrl).toBe('https://******@github.com/repo.git');
    expect(sanitized.stderr).toBe(
      'fatal: https://******@gitlab.com/project.git'
    );
    expect(sanitized.customField.nested).toBe(
      'Error: https://******@example.com/path'
    );
    expect(sanitized.urls[0]).toBe('https://******@github.com/private.git');
    expect(sanitized.urls[1]).toBe('https://github.com/public.git');
    expect(sanitized.exitCode).toBe(128);
  });

  it('should handle edge cases', () => {
    expect(sanitizeGitData(null)).toBe(null);
    expect(sanitizeGitData(undefined)).toBe(undefined);
    expect(sanitizeGitData('https://token@github.com/repo.git')).toBe(
      'https://******@github.com/repo.git'
    );
  });
});

describe('GitLogger', () => {
  it('should sanitize Error objects in error() method', () => {
    const baseLogger = createNoOpLogger();
    const errorSpy = vi.spyOn(baseLogger, 'error');
    const gitLogger = new GitLogger(baseLogger);

    const error = new Error(
      'Auth failed for https://token@github.com/repo.git'
    );
    gitLogger.error('Git operation failed', error);

    expect(errorSpy).toHaveBeenCalledWith(
      'Git operation failed',
      expect.objectContaining({
        message: 'Auth failed for https://******@github.com/repo.git'
      }),
      undefined
    );
  });
});
