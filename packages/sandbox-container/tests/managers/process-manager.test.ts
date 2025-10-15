import { beforeEach, describe, expect, it } from 'bun:test';
import type { ProcessOptions } from '@sandbox-container/core/types.ts';
import { ProcessManager } from '@sandbox-container/managers/process-manager.ts';

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

  describe('parseCommand', () => {
    it('should parse simple command', () => {
      const result = manager.parseCommand('echo hello');

      expect(result.executable).toBe('echo');
      expect(result.args).toEqual(['hello']);
    });

    it('should parse command with multiple arguments', () => {
      const result = manager.parseCommand('git clone https://github.com/user/repo.git');

      expect(result.executable).toBe('git');
      expect(result.args).toEqual(['clone', 'https://github.com/user/repo.git']);
    });

    it('should parse command with no arguments', () => {
      const result = manager.parseCommand('ls');

      expect(result.executable).toBe('ls');
      expect(result.args).toEqual([]);
    });

    it('should handle extra whitespace between arguments', () => {
      const result = manager.parseCommand('npm   run    build');

      expect(result.executable).toBe('npm');
      expect(result.args).toEqual(['run', 'build']);
    });

    it('should handle empty string by returning empty executable', () => {
      const result = manager.parseCommand('');

      expect(result.executable).toBe('');
      expect(result.args).toEqual([]);
    });

    it('should parse command with flags', () => {
      const result = manager.parseCommand('ls -la --color=auto');

      expect(result.executable).toBe('ls');
      expect(result.args).toEqual(['-la', '--color=auto']);
    });
  });

  describe('createProcessRecord', () => {
    it('should create process record with all required fields', () => {
      const options: ProcessOptions = {
        sessionId: 'session-123',
        cwd: '/tmp',
        env: { NODE_ENV: 'test' },
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

      const result = manager.createProcessRecord('sleep 10', undefined, options);

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

  describe('shouldCleanupProcess', () => {
    it('should cleanup old terminal process', () => {
      const process = {
        status: 'completed' as const,
        startTime: new Date('2024-01-01T00:00:00Z'),
      };
      const olderThan = new Date('2024-01-01T01:00:00Z');

      const result = manager.shouldCleanupProcess(process, olderThan);

      expect(result).toBe(true);
    });

    it('should not cleanup running process even if old', () => {
      const process = {
        status: 'running' as const,
        startTime: new Date('2024-01-01T00:00:00Z'),
      };
      const olderThan = new Date('2024-01-01T01:00:00Z');

      const result = manager.shouldCleanupProcess(process, olderThan);

      expect(result).toBe(false);
    });

    it('should not cleanup recent process', () => {
      const process = {
        status: 'completed' as const,
        startTime: new Date('2024-01-01T02:00:00Z'),
      };
      const olderThan = new Date('2024-01-01T01:00:00Z');

      const result = manager.shouldCleanupProcess(process, olderThan);

      expect(result).toBe(false);
    });
  });

  describe('validateProcessOptions', () => {
    it('should return valid for empty options', () => {
      const result = manager.validateProcessOptions({});

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return valid for options with all fields', () => {
      const options: ProcessOptions = {
        sessionId: 'session-123',
        cwd: '/tmp',
        env: { NODE_ENV: 'test' },
      };

      const result = manager.validateProcessOptions(options);

      expect(result.valid).toBe(true);
    });
  });

  describe('createCleanupCutoffDate', () => {
    it('should create date N minutes ago', () => {
      const now = Date.now();
      const cutoff = manager.createCleanupCutoffDate(30);

      const expectedTime = now - 30 * 60 * 1000;
      const actualTime = cutoff.getTime();

      expect(Math.abs(actualTime - expectedTime)).toBeLessThan(1000);
    });

    it('should handle 0 minutes', () => {
      const now = Date.now();
      const cutoff = manager.createCleanupCutoffDate(0);

      const actualTime = cutoff.getTime();

      expect(Math.abs(actualTime - now)).toBeLessThan(1000);
    });
  });
});
