import { beforeEach, describe, expect, it } from 'bun:test';
import type { ProcessOptions } from '@sandbox-container/core/types';
import { ProcessManager } from '@sandbox-container/managers/process-manager';

describe('ProcessManager', () => {
  let manager: ProcessManager;

  beforeEach(() => {
    manager = new ProcessManager();
  });

  describe('validateCommand', () => {
    it('should return valid for non-empty command', () => {
      const result = manager.validateCommand('echo "hello"');

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.code).toBeUndefined();
    });

    it('should return invalid for empty command', () => {
      const result = manager.validateCommand('');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid command: empty command provided');
      expect(result.code).toBe('INVALID_COMMAND');
    });

    it('should return invalid for whitespace-only command', () => {
      const result = manager.validateCommand('   ');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid command: empty command provided');
      expect(result.code).toBe('INVALID_COMMAND');
    });

    it('should return valid for command with leading/trailing whitespace', () => {
      const result = manager.validateCommand('  ls -la  ');

      expect(result.valid).toBe(true);
    });
  });

  describe('createProcessRecord', () => {
    it('should create process record with all required fields', () => {
      const options: ProcessOptions = {
        sessionId: 'session-123',
        cwd: '/tmp',
        env: { NODE_ENV: 'test' }
      };

      const result = manager.createProcessRecord('echo test', 12345, options);

      expect(result.id).toMatch(/^proc_\d+_[a-z0-9]+$/);
      expect(result.command).toBe('echo test');
      expect(result.pid).toBe(12345);
      expect(result.status).toBe('running');
      expect(result.startTime).toBeInstanceOf(Date);
      expect(result.sessionId).toBe('session-123');
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.outputListeners).toBeInstanceOf(Set);
      expect(result.statusListeners).toBeInstanceOf(Set);
    });

    it('should create process record with undefined pid', () => {
      const options: ProcessOptions = {};

      const result = manager.createProcessRecord(
        'sleep 10',
        undefined,
        options
      );

      expect(result.pid).toBeUndefined();
      expect(result.command).toBe('sleep 10');
    });

    it('should create process record without sessionId', () => {
      const options: ProcessOptions = {};

      const result = manager.createProcessRecord('ls', 99999, options);

      expect(result.sessionId).toBeUndefined();
    });
  });

  describe('generateProcessId', () => {
    it('should generate unique IDs', () => {
      const id1 = manager.generateProcessId();
      const id2 = manager.generateProcessId();

      expect(id1).not.toBe(id2);
    });

    it('should match expected format', () => {
      const id = manager.generateProcessId();

      expect(id).toMatch(/^proc_\d+_[a-z0-9]{6}$/);
    });
  });

  describe('interpretExitCode', () => {
    it('should return completed for exit code 0', () => {
      const result = manager.interpretExitCode(0);

      expect(result).toBe('completed');
    });

    it('should return failed for non-zero exit code', () => {
      const result = manager.interpretExitCode(1);

      expect(result).toBe('failed');
    });
  });
});
