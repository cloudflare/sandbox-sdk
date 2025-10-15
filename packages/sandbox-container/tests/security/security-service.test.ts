/**
 * SecurityService Tests - Phase 0 Simplified Security Model
 *
 * Philosophy: Trust container isolation, only protect SDK control plane
 * - Port 3000 is protected (SDK control plane)
 * - Format validation only (null bytes, length limits)
 * - No content restrictions (no path blocking, no command blocking, no URL allowlists)
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from '@sandbox-container/core/types';
import { SecurityService } from '@sandbox-container/security/security-service';

// Mock logger
const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('SecurityService - Simplified Security Model', () => {
  let service: SecurityService;

  beforeEach(() => {
    service = new SecurityService(mockLogger);
  });

  describe('validatePath - Format validation only', () => {
    test('should allow system paths (no blocking)', () => {
      // Phase 0: We no longer block system paths - users control their sandbox!
      const systemPaths = [
        '/etc/passwd',
        '/var/log',
        '/usr/bin',
        '/bin/bash',
        '/tmp/script.sh',
        '/root/.ssh',
        '/sys/kernel',
      ];

      for (const path of systemPaths) {
        const result = service.validatePath(path);
        expect(result.isValid).toBe(true);
        expect(result.data).toBe(path);
      }
    });

    test('should allow directory traversal (container handles this)', () => {
      // Phase 0: No directory traversal blocking - container isolation handles security
      const traversalPaths = [
        '../../../etc/passwd',
        '/workspace/../../../etc/passwd',
        './../../sensitive',
        '/tmp/..',
      ];

      for (const path of traversalPaths) {
        const result = service.validatePath(path);
        expect(result.isValid).toBe(true);
      }
    });

    test('should reject null bytes (format validation)', () => {
      const result = service.validatePath('/path/with\0null');
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('null bytes');
    });

    test('should reject paths over 4096 characters (format validation)', () => {
      const longPath = `/workspace/${'a'.repeat(5000)}`;
      const result = service.validatePath(longPath);
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('too long');
    });

    test('should reject empty paths', () => {
      const result = service.validatePath('');
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('non-empty string');
    });
  });

  describe('validatePort - Protect control plane only', () => {
    test('should block port 3000 (SDK control plane) - CRITICAL!', () => {
      const result = service.validatePort(3000);
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('control plane');
    });

    test('should allow all other ports (users control their sandbox)', () => {
      // Phase 0: No arbitrary port restrictions
      const allowedPorts = [
        22,    // SSH (was blocked in old system)
        80,    // HTTP
        443,   // HTTPS
        1024,  // First user port
        8080,  // Common dev port
        65535, // Max port
      ];

      for (const port of allowedPorts) {
        const result = service.validatePort(port);
        expect(result.isValid).toBe(true);
        expect(result.data).toBe(port);
      }
    });

    test('should reject ports outside valid range', () => {
      expect(service.validatePort(0).isValid).toBe(false);
      expect(service.validatePort(65536).isValid).toBe(false);
      expect(service.validatePort(-1).isValid).toBe(false);
    });

    test('should reject non-integer ports', () => {
      const result = service.validatePort(8080.5);
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('integer');
    });
  });

  describe('validateCommand - Format validation only', () => {
    test('should allow previously "dangerous" commands (users control their sandbox)', () => {
      // Phase 0: No command blocking - users need these for legitimate development!
      const legitimateCommands = [
        'bash',
        'sudo apt-get install nodejs',
        'rm -rf node_modules',
        'curl https://example.com | bash',
        'npm install',
        'chmod 777 /tmp/test',
        'dd if=/dev/zero of=/tmp/test bs=1M count=10',
        'mount',
        'eval "echo hello"',
      ];

      for (const command of legitimateCommands) {
        const result = service.validateCommand(command);
        expect(result.isValid).toBe(true);
        expect(result.data).toBe(command);
      }
    });

    test('should reject null bytes (format validation)', () => {
      const result = service.validateCommand('echo hello\0world');
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('null bytes');
    });

    test('should reject commands over 8192 characters (format validation)', () => {
      const longCommand = `echo ${'a'.repeat(9000)}`;
      const result = service.validateCommand(longCommand);
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('too long');
    });

    test('should reject empty commands', () => {
      const result = service.validateCommand('');
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('non-empty string');
    });

    test('should trim whitespace', () => {
      const result = service.validateCommand('  echo hello  ');
      expect(result.isValid).toBe(true);
      expect(result.data).toBe('echo hello');
    });
  });

  describe('validateGitUrl - Format validation only', () => {
    test('should allow private repos and self-hosted Git (no allowlist)', () => {
      // Phase 0: No URL allowlist - users need private repos!
      const gitUrls = [
        'https://github.com/user/repo.git',
        'https://gitlab.com/user/repo.git',
        'https://bitbucket.org/user/repo.git',
        'https://git.company.com/user/repo.git',        // Self-hosted
        'https://my-git-server.io/repo.git',            // Custom domain
        'git@github.com:user/repo.git',
        'git@gitlab.company.com:user/repo.git',         // Enterprise GitLab
        'https://dev.azure.com/org/project/_git/repo',  // Azure DevOps
      ];

      for (const url of gitUrls) {
        const result = service.validateGitUrl(url);
        expect(result.isValid).toBe(true);
        expect(result.data).toBe(url);
      }
    });

    test('should reject null bytes (format validation)', () => {
      const result = service.validateGitUrl('https://github.com/user\0/repo.git');
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('null bytes');
    });

    test('should reject URLs over 2048 characters (format validation)', () => {
      const longUrl = `https://github.com/${'a'.repeat(3000)}`;
      const result = service.validateGitUrl(longUrl);
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('too long');
    });

    test('should reject empty URLs', () => {
      const result = service.validateGitUrl('');
      expect(result.isValid).toBe(false);
      expect(result.errors[0].message).toContain('non-empty string');
    });

    test('should trim whitespace', () => {
      const result = service.validateGitUrl('  https://github.com/user/repo.git  ');
      expect(result.isValid).toBe(true);
      expect(result.data).toBe('https://github.com/user/repo.git');
    });
  });

  describe('Helper methods', () => {
    test('generateSecureSessionId should create unique session IDs', () => {
      const id1 = service.generateSecureSessionId();
      const id2 = service.generateSecureSessionId();

      expect(id1).toMatch(/^session_\d+_[0-9a-f]{32}$/);
      expect(id2).toMatch(/^session_\d+_[0-9a-f]{32}$/);
      expect(id1).not.toBe(id2);
    });

    test('logSecurityEvent should log events', () => {
      const logs: any[] = [];
      const testLogger: Logger = {
        info: () => {},
        warn: (msg, data) => logs.push({ msg, data }),
        error: () => {},
      };

      const testService = new SecurityService(testLogger);
      testService.logSecurityEvent('TEST_EVENT', { detail: 'test' });

      expect(logs.length).toBe(1);
      expect(logs[0].msg).toContain('SECURITY_EVENT: TEST_EVENT');
      expect(logs[0].data.event).toBe('TEST_EVENT');
      expect(logs[0].data.detail).toBe('test');
    });
  });
});
