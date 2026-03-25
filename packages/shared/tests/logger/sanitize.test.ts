import { describe, expect, it } from 'vitest';
import {
  redactCommand,
  redactCredentials,
  redactSensitiveParams,
  truncateForLog
} from '../../src/logger/sanitize';

describe('redactCredentials', () => {
  it('redacts credentials from HTTPS URLs', () => {
    expect(redactCredentials('https://token@github.com/repo.git')).toBe(
      'https://******@github.com/repo.git'
    );
    expect(redactCredentials('https://user:pass@example.com/path')).toBe(
      'https://******@example.com/path'
    );
  });

  it('leaves URLs without credentials unchanged', () => {
    expect(redactCredentials('https://github.com/public.git')).toBe(
      'https://github.com/public.git'
    );
  });

  it('redacts credentials from URLs embedded in text', () => {
    expect(
      redactCredentials('fatal: https://oauth2:token@github.com/repo.git')
    ).toBe('fatal: https://******@github.com/repo.git');
  });

  it('handles multiple URLs in a single string', () => {
    expect(
      redactCredentials(
        'Error: https://t1@host1.com failed, tried https://t2@host2.com'
      )
    ).toBe(
      'Error: https://******@host1.com failed, tried https://******@host2.com'
    );
  });

  it('returns strings without URLs unchanged', () => {
    expect(redactCredentials('no urls here')).toBe('no urls here');
    expect(redactCredentials('')).toBe('');
  });
});

describe('redactSensitiveParams', () => {
  it('strips X-Amz-Credential from URLs', () => {
    const url =
      'https://bucket.r2.cloudflarestorage.com/file?X-Amz-Credential=AKID123&X-Amz-Expires=3600';
    const result = redactSensitiveParams(url);
    expect(result).toContain('X-Amz-Credential=REDACTED');
    expect(result).not.toContain('AKID123');
    expect(result).toContain('X-Amz-Expires=3600');
  });

  it('strips X-Amz-Signature from URLs', () => {
    const url =
      'https://bucket.r2.cloudflarestorage.com/file?X-Amz-Signature=abc123def456&X-Amz-Expires=3600';
    const result = redactSensitiveParams(url);
    expect(result).toContain('X-Amz-Signature=REDACTED');
    expect(result).not.toContain('abc123def456');
  });

  it('strips X-Amz-Security-Token from URLs', () => {
    const url =
      'https://bucket.example.com/file?X-Amz-Security-Token=longtoken123&other=ok';
    const result = redactSensitiveParams(url);
    expect(result).toContain('X-Amz-Security-Token=REDACTED');
    expect(result).not.toContain('longtoken123');
    expect(result).toContain('other=ok');
  });

  it('strips token, secret, and password params', () => {
    const url =
      'https://example.com/api?token=abc123&secret=xyz789&password=hunter2&action=run';
    const result = redactSensitiveParams(url);
    expect(result).toContain('token=REDACTED');
    expect(result).toContain('secret=REDACTED');
    expect(result).toContain('password=REDACTED');
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('xyz789');
    expect(result).not.toContain('hunter2');
    expect(result).toContain('action=run');
  });

  it('handles multiple sensitive params in one URL', () => {
    const url =
      'https://bucket.r2.cloudflarestorage.com/file?X-Amz-Credential=AKID&X-Amz-Signature=SIG&X-Amz-Expires=3600';
    const result = redactSensitiveParams(url);
    expect(result).toContain('X-Amz-Credential=REDACTED');
    expect(result).toContain('X-Amz-Signature=REDACTED');
    expect(result).toContain('X-Amz-Expires=3600');
  });

  it('returns non-URL strings unchanged', () => {
    expect(redactSensitiveParams('just a plain string')).toBe(
      'just a plain string'
    );
    expect(redactSensitiveParams('no-url-here')).toBe('no-url-here');
    expect(redactSensitiveParams('')).toBe('');
  });

  it('leaves URLs without sensitive params unchanged', () => {
    const url = 'https://example.com/file?page=1&sort=name';
    expect(redactSensitiveParams(url)).toBe(url);
  });
});

describe('redactCommand', () => {
  it('redacts presigned URLs in curl commands', () => {
    const cmd =
      'curl "https://bucket.r2.cloudflarestorage.com/file?X-Amz-Credential=AKID&X-Amz-Signature=SIG"';
    const result = redactCommand(cmd);
    expect(result).toContain('X-Amz-Credential=REDACTED');
    expect(result).toContain('X-Amz-Signature=REDACTED');
    expect(result).not.toContain('AKID');
    expect(result).not.toContain('SIG');
  });

  it('redacts git credential URLs', () => {
    const cmd = 'git clone https://token@github.com/user/repo.git';
    const result = redactCommand(cmd);
    expect(result).toContain('https://******@github.com/user/repo.git');
    expect(result).not.toContain('token@');
  });

  it('composes both credential and param redaction', () => {
    const cmd =
      'curl https://user:pass@bucket.example.com/file?X-Amz-Credential=AKID&X-Amz-Signature=SIG';
    const result = redactCommand(cmd);
    expect(result).toContain('******@');
    expect(result).toContain('X-Amz-Credential=REDACTED');
    expect(result).toContain('X-Amz-Signature=REDACTED');
  });

  it('passes safe commands through unchanged', () => {
    expect(redactCommand('ls -la /tmp')).toBe('ls -la /tmp');
    expect(redactCommand('echo hello')).toBe('echo hello');
  });
});

describe('truncateForLog', () => {
  it('passes short strings unchanged', () => {
    const result = truncateForLog('hello');
    expect(result).toEqual({ value: 'hello', truncated: false });
  });

  it('truncates strings exceeding default max length', () => {
    const long = 'a'.repeat(200);
    const result = truncateForLog(long);
    expect(result.truncated).toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(120);
    expect(result.value).toContain('...');
  });

  it('truncates at custom max length', () => {
    const result = truncateForLog('abcdefghij', 5);
    expect(result.truncated).toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(5);
  });

  it('does not truncate strings at exactly max length', () => {
    const exact = 'a'.repeat(120);
    const result = truncateForLog(exact);
    expect(result).toEqual({ value: exact, truncated: false });
  });

  it('handles empty strings', () => {
    const result = truncateForLog('');
    expect(result).toEqual({ value: '', truncated: false });
  });
});
