import { describe, expect, it } from 'vitest';
import {
  redactCommand,
  redactCredentials,
  redactSensitiveParams,
  truncateForLog
} from '../../src/logger/sanitize';

describe('redactCredentials', () => {
  it('redacts embedded credentials from URLs', () => {
    expect(redactCredentials('https://token@github.com/repo.git')).toBe(
      'https://******@github.com/repo.git'
    );
    expect(redactCredentials('https://user:pass@example.com/path')).toBe(
      'https://******@example.com/path'
    );
  });

  it('handles URLs embedded in text and multiple URLs', () => {
    expect(
      redactCredentials(
        'Error: https://t1@host1.com failed, tried https://t2@host2.com'
      )
    ).toBe(
      'Error: https://******@host1.com failed, tried https://******@host2.com'
    );
  });

  it('returns strings without credentials unchanged', () => {
    expect(redactCredentials('https://github.com/public.git')).toBe(
      'https://github.com/public.git'
    );
    expect(redactCredentials('no urls here')).toBe('no urls here');
  });
});

describe('redactSensitiveParams', () => {
  it('redacts all sensitive param types while preserving non-sensitive ones', () => {
    const url =
      'https://r2.example.com/f?X-Amz-Credential=AKID&X-Amz-Signature=SIG&X-Amz-Expires=3600&token=tok1&secret=sec1';
    const result = redactSensitiveParams(url);
    expect(result).toContain('X-Amz-Credential=REDACTED');
    expect(result).toContain('X-Amz-Signature=REDACTED');
    expect(result).toContain('token=REDACTED');
    expect(result).toContain('secret=REDACTED');
    expect(result).not.toContain('AKID');
    expect(result).not.toContain('SIG');
    expect(result).toContain('X-Amz-Expires=3600');
  });

  it('returns non-URL strings and URLs without sensitive params unchanged', () => {
    expect(redactSensitiveParams('plain string')).toBe('plain string');
    expect(redactSensitiveParams('')).toBe('');
    expect(redactSensitiveParams('https://example.com/file?page=1')).toBe(
      'https://example.com/file?page=1'
    );
  });

  it('does not match param names in URL path segments', () => {
    expect(
      redactSensitiveParams('https://example.com/api/token/refresh?action=run')
    ).toBe('https://example.com/api/token/refresh?action=run');
  });

  it('stops at URL delimiters in quoted commands', () => {
    const cmd =
      'curl "https://r2.example.com/f?token=secret123" -H "Accept: json"';
    const result = redactSensitiveParams(cmd);
    expect(result).toContain('token=REDACTED');
    expect(result).toContain('-H "Accept: json"');
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
  it('passes strings within limit unchanged', () => {
    expect(truncateForLog('hello')).toEqual({
      value: 'hello',
      truncated: false
    });
    expect(truncateForLog('a'.repeat(120))).toEqual({
      value: 'a'.repeat(120),
      truncated: false
    });
  });

  it('truncates long strings and sets truncated flag', () => {
    const result = truncateForLog('a'.repeat(200));
    expect(result.truncated).toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(121); // 120 + ellipsis char
  });
});
