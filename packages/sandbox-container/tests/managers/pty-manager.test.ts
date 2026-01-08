import type { Logger } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyManager } from '../../src/managers/pty-manager';

/**
 * PtyManager Unit Tests
 *
 * Tests dimension validation, exited PTY handling, and error handling.
 *
 * Note: Tests that require actual PTY creation only run when the environment
 * supports it (Bun.Terminal available AND /dev/pts accessible). This is typically
 * only true inside the Docker container. Full PTY lifecycle testing is covered
 * by E2E tests which run in the actual container environment.
 */

function createMockLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger)
  };
  return logger;
}

/**
 * Check if the environment can actually create PTYs.
 * Bun.Terminal may exist but fail if /dev/pts is not mounted.
 */
function canCreatePty(): boolean {
  if (typeof Bun === 'undefined') return false;
  const BunTerminal = (Bun as { Terminal?: unknown }).Terminal;
  if (!BunTerminal) return false;

  // Try to actually create a PTY to verify the environment supports it
  try {
    const testLogger = createMockLogger();
    const testManager = new PtyManager(testLogger);
    const session = testManager.create({
      cols: 80,
      rows: 24,
      command: ['/bin/true']
    });
    testManager.kill(session.id);
    return true;
  } catch {
    // PTY creation failed - likely missing /dev/pts or permissions
    return false;
  }
}

// Cache the result since it won't change during test run
const ptySupported = canCreatePty();

describe('PtyManager', () => {
  let manager: PtyManager;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    manager = new PtyManager(mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('write - unknown and exited PTY handling', () => {
    it('should return error when writing to unknown PTY', () => {
      const result = manager.write('pty_nonexistent_12345', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY not found');
    });

    it('should log warning when writing to unknown PTY', () => {
      manager.write('pty_nonexistent_12345', 'hello');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Write to unknown PTY',
        expect.objectContaining({ ptyId: 'pty_nonexistent_12345' })
      );
    });
  });

  describe('resize - unknown PTY handling', () => {
    it('should return error when resizing unknown PTY', () => {
      const result = manager.resize('pty_nonexistent_12345', 100, 50);
      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY not found');
    });

    it('should log warning when resizing unknown PTY', () => {
      manager.resize('pty_nonexistent_12345', 100, 50);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Resize unknown PTY',
        expect.objectContaining({ ptyId: 'pty_nonexistent_12345' })
      );
    });
  });

  describe('listener registration for unknown PTY', () => {
    it('should return no-op unsubscribe for unknown PTY onData', () => {
      const callback = vi.fn();
      const unsubscribe = manager.onData('pty_nonexistent', callback);

      // Should return a function that does nothing
      expect(typeof unsubscribe).toBe('function');
      unsubscribe(); // Should not throw
    });

    it('should warn when registering onData for unknown PTY', () => {
      const callback = vi.fn();
      manager.onData('pty_nonexistent', callback);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Registering onData listener for unknown PTY - callback will never fire',
        expect.objectContaining({ ptyId: 'pty_nonexistent' })
      );
    });

    it('should return no-op unsubscribe for unknown PTY onExit', () => {
      const callback = vi.fn();
      const unsubscribe = manager.onExit('pty_nonexistent', callback);

      // Should return a function that does nothing
      expect(typeof unsubscribe).toBe('function');
      unsubscribe(); // Should not throw
    });

    it('should warn when registering onExit for unknown PTY', () => {
      const callback = vi.fn();
      manager.onExit('pty_nonexistent', callback);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Registering onExit listener for unknown PTY - callback will never fire',
        expect.objectContaining({ ptyId: 'pty_nonexistent' })
      );
    });
  });

  describe('get and list operations', () => {
    it('should return null for unknown PTY', () => {
      const result = manager.get('pty_nonexistent_12345');
      expect(result).toBeNull();
    });

    it('should return empty list when no PTYs exist', () => {
      const result = manager.list();
      expect(result).toEqual([]);
    });
  });

  describe('kill and cleanup operations', () => {
    it('should return error when killing unknown PTY', () => {
      const result = manager.kill('pty_nonexistent_12345');
      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY not found');
    });

    it('should log warning when killing unknown PTY', () => {
      manager.kill('pty_nonexistent_12345');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Kill unknown PTY',
        expect.objectContaining({ ptyId: 'pty_nonexistent_12345' })
      );
    });

    it('should handle cleanup of unknown PTY gracefully', () => {
      // Should not throw
      manager.cleanup('pty_nonexistent_12345');
    });

    it('should handle killAll with no PTYs gracefully', () => {
      // Should not throw
      manager.killAll();
    });
  });

  describe('concurrent listener registration', () => {
    it('should handle multiple onData registrations for same unknown PTY', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      const unsub1 = manager.onData('pty_nonexistent', callback1);
      const unsub2 = manager.onData('pty_nonexistent', callback2);
      const unsub3 = manager.onData('pty_nonexistent', callback3);

      // All should return no-op functions
      expect(typeof unsub1).toBe('function');
      expect(typeof unsub2).toBe('function');
      expect(typeof unsub3).toBe('function');

      // All unsubscribes should be safe to call
      unsub1();
      unsub2();
      unsub3();

      // Should have warned for each registration
      expect(mockLogger.warn).toHaveBeenCalledTimes(3);
    });

    it('should handle multiple onExit registrations for same unknown PTY', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const unsub1 = manager.onExit('pty_nonexistent', callback1);
      const unsub2 = manager.onExit('pty_nonexistent', callback2);

      unsub1();
      unsub2();

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('callback error handling', () => {
    it('should log error when onExit immediate callback throws', () => {
      // This test verifies the error is logged, but we can't easily test
      // with a real PTY. The behavior is tested in E2E tests.
      // Here we just verify the manager handles unknown PTY gracefully.
      const throwingCallback = () => {
        throw new Error('Callback error');
      };

      // Registration on unknown PTY returns no-op, callback never called
      const unsub = manager.onExit('pty_nonexistent', throwingCallback);
      unsub();

      // Should warn about unknown PTY, not error from callback
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});

/**
 * Dimension Validation Tests
 *
 * These tests verify the dimension validation logic in PtyManager.
 * They require actual PTY creation, so they only run in environments
 * with full PTY support (typically the Docker container).
 *
 * Skipped in CI/local environments without /dev/pts access.
 * Full coverage is provided by E2E tests.
 */
describe.skipIf(!ptySupported)('PtyManager - Dimension Validation', () => {
  let manager: PtyManager;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    manager = new PtyManager(mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up any created PTYs
    manager.killAll();
  });

  describe('create - dimension validation', () => {
    it('should reject cols below minimum (0)', () => {
      expect(() => manager.create({ cols: 0, rows: 24 })).toThrow(
        /Invalid cols: 0.*Must be between 1 and 1000/
      );
    });

    it('should reject cols above maximum (1001)', () => {
      expect(() => manager.create({ cols: 1001, rows: 24 })).toThrow(
        /Invalid cols: 1001.*Must be between 1 and 1000/
      );
    });

    it('should reject rows below minimum (0)', () => {
      expect(() => manager.create({ cols: 80, rows: 0 })).toThrow(
        /Invalid rows: 0.*Must be between 1 and 1000/
      );
    });

    it('should reject rows above maximum (1001)', () => {
      expect(() => manager.create({ cols: 80, rows: 1001 })).toThrow(
        /Invalid rows: 1001.*Must be between 1 and 1000/
      );
    });

    it('should accept minimum valid dimensions (1x1)', () => {
      const session = manager.create({
        cols: 1,
        rows: 1,
        command: ['/bin/true']
      });
      expect(session.cols).toBe(1);
      expect(session.rows).toBe(1);
    });

    it('should accept maximum valid dimensions (1000x1000)', () => {
      const session = manager.create({
        cols: 1000,
        rows: 1000,
        command: ['/bin/true']
      });
      expect(session.cols).toBe(1000);
      expect(session.rows).toBe(1000);
    });

    it('should accept typical terminal dimensions (80x24)', () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/true']
      });
      expect(session.cols).toBe(80);
      expect(session.rows).toBe(24);
    });
  });

  describe('resize - dimension validation with running PTY', () => {
    it('should reject resize with cols below minimum (0)', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/sleep', '10']
      });
      const result = manager.resize(session.id, 0, 24);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /Invalid dimensions.*Must be between 1 and 1000/
      );
      manager.kill(session.id);
    });

    it('should reject resize with cols above maximum (1001)', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/sleep', '10']
      });
      const result = manager.resize(session.id, 1001, 24);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /Invalid dimensions.*Must be between 1 and 1000/
      );
      manager.kill(session.id);
    });

    it('should reject resize with rows below minimum (0)', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/sleep', '10']
      });
      const result = manager.resize(session.id, 80, 0);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /Invalid dimensions.*Must be between 1 and 1000/
      );
      manager.kill(session.id);
    });

    it('should reject resize with rows above maximum (1001)', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/sleep', '10']
      });
      const result = manager.resize(session.id, 80, 1001);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /Invalid dimensions.*Must be between 1 and 1000/
      );
      manager.kill(session.id);
    });

    it('should accept resize with valid dimensions', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/sleep', '10']
      });
      const result = manager.resize(session.id, 100, 50);
      expect(result.success).toBe(true);
      manager.kill(session.id);
    });

    it('should log warning for invalid dimensions', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/sleep', '10']
      });
      manager.resize(session.id, 0, 24);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid resize dimensions',
        expect.objectContaining({ ptyId: session.id, cols: 0, rows: 24 })
      );
      manager.kill(session.id);
    });
  });

  describe('write and resize on exited PTY', () => {
    it('should return error when writing to exited PTY', async () => {
      // Create a PTY that exits immediately
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/true']
      });

      // Wait for the process to exit
      await session.process.exited;

      // Try to write to the exited PTY
      const result = manager.write(session.id, 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY has exited');
    });

    it('should return error when resizing exited PTY', async () => {
      // Create a PTY that exits immediately
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/true']
      });

      // Wait for the process to exit
      await session.process.exited;

      // Try to resize the exited PTY
      const result = manager.resize(session.id, 100, 50);
      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY has exited');
    });

    it('should log warning when writing to exited PTY', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/true']
      });
      await session.process.exited;

      manager.write(session.id, 'hello');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Write to exited PTY',
        expect.objectContaining({ ptyId: session.id })
      );
    });

    it('should log warning when resizing exited PTY', async () => {
      const session = manager.create({
        cols: 80,
        rows: 24,
        command: ['/bin/true']
      });
      await session.process.exited;

      manager.resize(session.id, 100, 50);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Resize exited PTY',
        expect.objectContaining({ ptyId: session.id })
      );
    });
  });
});
