import { describe, expect, it } from 'vitest';
import { sanitizeCommandForLog } from '../src/log-sanitize';

describe('sanitizeCommandForLog', () => {
  describe('passthrough cases', () => {
    it('returns empty string unchanged', () => {
      expect(sanitizeCommandForLog('')).toBe('');
    });

    it('returns safe commands unchanged', () => {
      expect(sanitizeCommandForLog('ls -la /tmp')).toBe('ls -la /tmp');
      expect(sanitizeCommandForLog('echo hello world')).toBe(
        'echo hello world'
      );
      expect(sanitizeCommandForLog('git status')).toBe('git status');
      expect(sanitizeCommandForLog('npm install')).toBe('npm install');
    });

    it('does not redact unset commands (no value to redact)', () => {
      expect(sanitizeCommandForLog('unset API_KEY')).toBe('unset API_KEY');
      expect(sanitizeCommandForLog('unset SECRET_TOKEN')).toBe(
        'unset SECRET_TOKEN'
      );
    });

    it('does not redact export with no value', () => {
      expect(sanitizeCommandForLog('export MY_VAR')).toBe('export MY_VAR');
    });

    it('does not redact non-sensitive export assignments', () => {
      expect(sanitizeCommandForLog('export PATH=/usr/bin:/usr/local/bin')).toBe(
        'export PATH=/usr/bin:/usr/local/bin'
      );
      expect(sanitizeCommandForLog('export HOME=/home/user')).toBe(
        'export HOME=/home/user'
      );
      expect(sanitizeCommandForLog('export PS1="\\u@\\h:\\w\\$ "')).toBe(
        'export PS1="\\u@\\h:\\w\\$ "'
      );
    });

    it('does not redact non-sensitive inline assignments', () => {
      expect(sanitizeCommandForLog('NODE_ENV=production npm start')).toBe(
        'NODE_ENV=production npm start'
      );
      expect(sanitizeCommandForLog('DEBUG=1 node server.js')).toBe(
        'DEBUG=1 node server.js'
      );
    });
  });

  describe('export KEY=VALUE redaction', () => {
    it('redacts sensitive key names', () => {
      expect(sanitizeCommandForLog('export API_KEY=myapikey123')).toBe(
        'export API_KEY=[REDACTED]'
      );
      expect(sanitizeCommandForLog('export SECRET=topsecret')).toBe(
        'export SECRET=[REDACTED]'
      );
      expect(sanitizeCommandForLog('export DB_PASSWORD=hunter2')).toBe(
        'export DB_PASSWORD=[REDACTED]'
      );
      expect(
        sanitizeCommandForLog('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI')
      ).toBe('export AWS_SECRET_ACCESS_KEY=[REDACTED]');
      expect(
        sanitizeCommandForLog('export ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9')
      ).toBe('export ACCESS_TOKEN=[REDACTED]');
      expect(
        sanitizeCommandForLog('export GITHUB_TOKEN=ghp_abc123DEF456ghi789jkl')
      ).toBe('export GITHUB_TOKEN=[REDACTED]');
      expect(
        sanitizeCommandForLog(
          'export DATABASE_URL=postgres://user:pass@host/db'
        )
      ).toBe('export DATABASE_URL=[REDACTED]');
      expect(
        sanitizeCommandForLog(
          "export PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----'"
        )
      ).toBe('export PRIVATE_KEY=[REDACTED]');
    });

    it('redacts single-quoted values', () => {
      expect(sanitizeCommandForLog("export API_KEY='my-secret-key'")).toBe(
        'export API_KEY=[REDACTED]'
      );
      expect(sanitizeCommandForLog("export DB_PASSWORD='hunter2'")).toBe(
        'export DB_PASSWORD=[REDACTED]'
      );
    });

    it('redacts double-quoted values', () => {
      expect(sanitizeCommandForLog('export API_KEY="my-secret-key"')).toBe(
        'export API_KEY=[REDACTED]'
      );
    });

    it('redacts high-entropy values even for non-sensitive key names', () => {
      // A long random-looking token should be redacted even if key name is generic
      expect(sanitizeCommandForLog('export MYVAR=xK9mP2nQrT5vYwZa')).toBe(
        'export MYVAR=[REDACTED]'
      );
    });

    it('preserves surrounding command when export is part of a pipeline', () => {
      const result = sanitizeCommandForLog(
        'export API_KEY=secret123; echo done'
      );
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('echo done');
      expect(result).not.toContain('secret123');
    });
  });

  describe('inline env prefix redaction', () => {
    it('redacts sensitive key inline assignments', () => {
      expect(
        sanitizeCommandForLog('API_KEY=secret123 curl https://example.com')
      ).toBe('API_KEY=[REDACTED] curl https://example.com');
      expect(sanitizeCommandForLog('DB_PASSWORD=hunter2 node app.js')).toBe(
        'DB_PASSWORD=[REDACTED] node app.js'
      );
      expect(
        sanitizeCommandForLog('AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls')
      ).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED] aws s3 ls');
    });

    it('does not redact non-sensitive inline assignments', () => {
      expect(sanitizeCommandForLog('NODE_ENV=production node server.js')).toBe(
        'NODE_ENV=production node server.js'
      );
    });
  });

  describe('sensitive CLI flag redaction', () => {
    it('redacts --flag=value forms', () => {
      expect(sanitizeCommandForLog('gh auth login --token=ghp_abc123')).toBe(
        'gh auth login --token=[REDACTED]'
      );
      expect(sanitizeCommandForLog('npm publish --password=hunter2')).toBe(
        'npm publish --password=[REDACTED]'
      );
    });

    it('redacts --flag value forms', () => {
      expect(sanitizeCommandForLog('gh auth login --token ghp_abc123')).toBe(
        'gh auth login --token [REDACTED]'
      );
      expect(
        sanitizeCommandForLog(
          'curl -u user --password hunter2 https://example.com'
        )
      ).toBe('curl -u user --password [REDACTED] https://example.com');
    });

    it('redacts --secret, --key, --bearer, --credential flags', () => {
      expect(sanitizeCommandForLog('cmd --secret mysecretvalue')).toBe(
        'cmd --secret [REDACTED]'
      );
      expect(sanitizeCommandForLog('cmd --bearer eyJhbGciJ9.payload.sig')).toBe(
        'cmd --bearer [REDACTED]'
      );
      expect(sanitizeCommandForLog('cmd --credential user:pass')).toBe(
        'cmd --credential [REDACTED]'
      );
    });

    it('handles both hyphen and underscore variants', () => {
      expect(sanitizeCommandForLog('cmd --api-key secret123')).toBe(
        'cmd --api-key [REDACTED]'
      );
      expect(sanitizeCommandForLog('cmd --api_key secret123')).toBe(
        'cmd --api_key [REDACTED]'
      );
    });

    it('does not redact non-sensitive flags', () => {
      expect(sanitizeCommandForLog('ls --color=auto')).toBe('ls --color=auto');
      expect(sanitizeCommandForLog('curl --output result.json')).toBe(
        'curl --output result.json'
      );
    });
  });

  describe('entropy heuristic', () => {
    it('redacts high-entropy export values', () => {
      // 20+ char random-looking string has high entropy
      const result = sanitizeCommandForLog('export TOKEN=aB3cD4eF5gH6iJ7kL8mN');
      expect(result).toBe('export TOKEN=[REDACTED]');
    });

    it('does not redact short values on entropy alone', () => {
      // Short values below ENTROPY_MIN_LENGTH threshold
      expect(sanitizeCommandForLog('export MYVAR=abc')).toBe(
        'export MYVAR=abc'
      );
    });
  });

  describe('does not affect non-log execution behavior', () => {
    it('only modifies the string, not any side effects', () => {
      const original = 'export API_KEY=supersecret';
      const sanitized = sanitizeCommandForLog(original);
      expect(original).toBe('export API_KEY=supersecret');
      expect(sanitized).toBe('export API_KEY=[REDACTED]');
    });
  });
});
