import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import { PtyManager } from '../../src/managers/pty-manager';

// Note: These tests require Bun.Terminal (introduced in Bun v1.3.5+)

describe('PtyManager', () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager(createNoOpLogger());
  });

  afterEach(() => {
    manager.killAll();
  });

  describe('create', () => {
    it('should create a PTY session with default options', () => {
      // Use /bin/sh for cross-platform compatibility
      const session = manager.create({ command: ['/bin/sh'] });

      expect(session.id).toBeDefined();
      expect(session.cols).toBe(80);
      expect(session.rows).toBe(24);
      expect(session.state).toBe('running');
      expect(session.command).toEqual(['/bin/sh']);
    });

    it('should create a PTY session with custom options', () => {
      const session = manager.create({
        cols: 120,
        rows: 40,
        command: ['/bin/sh'],
        cwd: '/tmp'
      });

      expect(session.cols).toBe(120);
      expect(session.rows).toBe(40);
      expect(session.command).toEqual(['/bin/sh']);
      expect(session.cwd).toBe('/tmp');
    });

    it('should create PTY with session ID and track in sessionToPty map', () => {
      const session = manager.create({
        command: ['/bin/sh'],
        sessionId: 'test-session-123'
      });

      expect(session.sessionId).toBe('test-session-123');
      const retrieved = manager.getBySessionId('test-session-123');
      expect(retrieved?.id).toBe(session.id);
    });

    it('should create multiple PTYs with unique IDs', () => {
      const session1 = manager.create({ command: ['/bin/sh'] });
      const session2 = manager.create({ command: ['/bin/sh'] });
      const session3 = manager.create({ command: ['/bin/sh'] });

      expect(session1.id).not.toBe(session2.id);
      expect(session2.id).not.toBe(session3.id);
      expect(session1.id).not.toBe(session3.id);
    });

    it('should reject cols below minimum (1)', () => {
      expect(() => manager.create({ command: ['/bin/sh'], cols: 0 })).toThrow(
        'Invalid cols: 0. Must be between 1 and 1000'
      );
    });

    it('should reject cols above maximum (1000)', () => {
      expect(() =>
        manager.create({ command: ['/bin/sh'], cols: 1001 })
      ).toThrow('Invalid cols: 1001. Must be between 1 and 1000');
    });

    it('should reject rows below minimum (1)', () => {
      expect(() => manager.create({ command: ['/bin/sh'], rows: 0 })).toThrow(
        'Invalid rows: 0. Must be between 1 and 1000'
      );
    });

    it('should reject rows above maximum (1000)', () => {
      expect(() =>
        manager.create({ command: ['/bin/sh'], rows: 1001 })
      ).toThrow('Invalid rows: 1001. Must be between 1 and 1000');
    });

    it('should accept boundary values (1 and 1000)', () => {
      const session1 = manager.create({
        command: ['/bin/sh'],
        cols: 1,
        rows: 1
      });
      expect(session1.cols).toBe(1);
      expect(session1.rows).toBe(1);

      const session2 = manager.create({
        command: ['/bin/sh'],
        cols: 1000,
        rows: 1000
      });
      expect(session2.cols).toBe(1000);
      expect(session2.rows).toBe(1000);
    });
  });

  describe('get', () => {
    it('should return session by id', () => {
      const created = manager.create({ command: ['/bin/sh'] });
      const retrieved = manager.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return null for unknown id', () => {
      const retrieved = manager.get('unknown-id');
      expect(retrieved).toBeNull();
    });
  });

  describe('getBySessionId', () => {
    it('should return PTY by session ID', () => {
      const session = manager.create({
        command: ['/bin/sh'],
        sessionId: 'my-session'
      });

      const retrieved = manager.getBySessionId('my-session');
      expect(retrieved?.id).toBe(session.id);
    });

    it('should return null for unknown session ID', () => {
      const retrieved = manager.getBySessionId('nonexistent');
      expect(retrieved).toBeNull();
    });
  });

  describe('hasActivePty', () => {
    it('should return true for running PTY', () => {
      manager.create({
        command: ['/bin/sh'],
        sessionId: 'active-session'
      });

      expect(manager.hasActivePty('active-session')).toBe(true);
    });

    it('should return false for unknown session', () => {
      expect(manager.hasActivePty('unknown')).toBe(false);
    });

    it('should return false for exited PTY', async () => {
      const session = manager.create({
        command: ['/bin/sh'],
        sessionId: 'exiting-session'
      });

      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(manager.hasActivePty('exiting-session')).toBe(false);
    });
  });

  describe('list', () => {
    it('should return all sessions', () => {
      manager.create({ command: ['/bin/sh'] });
      manager.create({ command: ['/bin/sh'] });

      const list = manager.list();
      expect(list.length).toBe(2);
    });

    it('should return empty array when no sessions', () => {
      const list = manager.list();
      expect(list).toEqual([]);
    });

    it('should return PtyInfo objects with correct fields', () => {
      manager.create({
        command: ['/bin/sh'],
        cols: 100,
        rows: 50,
        cwd: '/tmp'
      });

      const list = manager.list();
      expect(list[0].cols).toBe(100);
      expect(list[0].rows).toBe(50);
      expect(list[0].cwd).toBe('/tmp');
      expect(list[0].state).toBe('running');
      expect(list[0].createdAt).toBeDefined();
    });
  });

  describe('write', () => {
    it('should write data to PTY', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      const result = manager.write(session.id, 'echo hello\n');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return error for unknown PTY', () => {
      const result = manager.write('unknown-id', 'test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY not found');
    });

    it('should return error for exited PTY', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = manager.write(session.id, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY has exited');
    });
  });

  describe('resize', () => {
    it('should resize PTY', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      const result = manager.resize(session.id, 100, 50);

      expect(result.success).toBe(true);
      const updated = manager.get(session.id);
      expect(updated?.cols).toBe(100);
      expect(updated?.rows).toBe(50);
    });

    it('should return error for unknown PTY', () => {
      const result = manager.resize('unknown-id', 100, 50);

      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY not found');
    });

    it('should return error for exited PTY', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = manager.resize(session.id, 100, 50);

      expect(result.success).toBe(false);
      expect(result.error).toBe('PTY has exited');
    });

    it('should reject cols below minimum (1)', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      const result = manager.resize(session.id, 0, 24);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Invalid dimensions. Must be between 1 and 1000'
      );
    });

    it('should reject cols above maximum (1000)', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      const result = manager.resize(session.id, 1001, 24);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Invalid dimensions. Must be between 1 and 1000'
      );
    });

    it('should reject rows below minimum (1)', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      const result = manager.resize(session.id, 80, 0);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Invalid dimensions. Must be between 1 and 1000'
      );
    });

    it('should reject rows above maximum (1000)', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      const result = manager.resize(session.id, 80, 1001);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Invalid dimensions. Must be between 1 and 1000'
      );
    });

    it('should accept boundary values (1 and 1000)', () => {
      const session = manager.create({ command: ['/bin/sh'] });

      const result1 = manager.resize(session.id, 1, 1);
      expect(result1.success).toBe(true);
      expect(manager.get(session.id)?.cols).toBe(1);
      expect(manager.get(session.id)?.rows).toBe(1);

      const result2 = manager.resize(session.id, 1000, 1000);
      expect(result2.success).toBe(true);
      expect(manager.get(session.id)?.cols).toBe(1000);
      expect(manager.get(session.id)?.rows).toBe(1000);
    });
  });

  describe('kill', () => {
    it('should kill PTY session', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      manager.kill(session.id);

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 100));

      const killed = manager.get(session.id);
      expect(killed?.state).toBe('exited');
    });

    it('should handle killing unknown PTY gracefully', () => {
      // Should not throw
      manager.kill('unknown-id');
    });

    it('should handle killing already-exited PTY gracefully', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not throw when killing again
      manager.kill(session.id);
    });
  });

  describe('killAll', () => {
    it('should kill all PTY sessions', async () => {
      manager.create({ command: ['/bin/sh'] });
      manager.create({ command: ['/bin/sh'] });
      manager.create({ command: ['/bin/sh'] });

      manager.killAll();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const list = manager.list();
      expect(list.every((p) => p.state === 'exited')).toBe(true);
    });
  });

  describe('onData', () => {
    it('should register data listener and receive output', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      const received: string[] = [];

      const unsubscribe = manager.onData(session.id, (data) => {
        received.push(data);
      });

      manager.write(session.id, 'echo test\n');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(received.length).toBeGreaterThan(0);
      unsubscribe();
    });

    it('should return no-op for unknown PTY', () => {
      const unsubscribe = manager.onData('unknown', () => {});
      // Should not throw
      unsubscribe();
    });

    it('should allow multiple listeners', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      let count1 = 0;
      let count2 = 0;

      const unsub1 = manager.onData(session.id, () => count1++);
      const unsub2 = manager.onData(session.id, () => count2++);

      manager.write(session.id, 'echo test\n');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(count1).toBeGreaterThan(0);
      expect(count2).toBeGreaterThan(0);
      expect(count1).toBe(count2);

      unsub1();
      unsub2();
    });

    it('should unsubscribe correctly', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      let count = 0;

      const unsubscribe = manager.onData(session.id, () => count++);

      manager.write(session.id, 'echo first\n');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const countAfterFirst = count;

      unsubscribe();

      manager.write(session.id, 'echo second\n');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Count should not have increased after unsubscribe
      expect(count).toBe(countAfterFirst);
    });
  });

  describe('onExit', () => {
    it('should register exit listener and receive exit code', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      let exitCode: number | undefined;

      manager.onExit(session.id, (code) => {
        exitCode = code;
      });

      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(exitCode).toBeDefined();
    });

    it('should call listener immediately for already-exited PTY', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      let exitCode: number | undefined;
      manager.onExit(session.id, (code) => {
        exitCode = code;
      });

      // Should be called synchronously for already-exited PTY
      expect(exitCode).toBeDefined();
    });

    it('should return no-op for unknown PTY', () => {
      const unsubscribe = manager.onExit('unknown', () => {});
      // Should not throw
      unsubscribe();
    });
  });

  describe('disconnect timer', () => {
    it('should start and cancel disconnect timer', () => {
      const session = manager.create({
        command: ['/bin/sh'],
        disconnectTimeout: 1000
      });

      manager.startDisconnectTimer(session.id);
      // Should have timer set
      expect(manager.get(session.id)?.disconnectTimer).toBeDefined();

      manager.cancelDisconnectTimer(session.id);
      // Timer should be cleared
      expect(manager.get(session.id)?.disconnectTimer).toBeUndefined();
    });

    it('should handle start timer for unknown PTY', () => {
      // Should not throw
      manager.startDisconnectTimer('unknown');
    });

    it('should handle cancel timer for unknown PTY', () => {
      // Should not throw
      manager.cancelDisconnectTimer('unknown');
    });
  });

  describe('cleanup', () => {
    it('should remove PTY from sessions and sessionToPty maps', () => {
      const session = manager.create({
        command: ['/bin/sh'],
        sessionId: 'cleanup-test'
      });

      expect(manager.get(session.id)).not.toBeNull();
      expect(manager.getBySessionId('cleanup-test')).not.toBeNull();

      manager.cleanup(session.id);

      expect(manager.get(session.id)).toBeNull();
      expect(manager.getBySessionId('cleanup-test')).toBeNull();
    });

    it('should cancel disconnect timer on cleanup', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      manager.startDisconnectTimer(session.id);

      manager.cleanup(session.id);

      // Session should be removed
      expect(manager.get(session.id)).toBeNull();
    });

    it('should handle cleanup for unknown PTY', () => {
      // Should not throw
      manager.cleanup('unknown');
    });
  });

  describe('listener cleanup on exit', () => {
    it('should clear listeners after PTY exits', async () => {
      const session = manager.create({ command: ['/bin/sh'] });

      // Add listeners
      manager.onData(session.id, () => {});
      manager.onExit(session.id, () => {});

      expect(session.dataListeners.size).toBe(1);
      expect(session.exitListeners.size).toBe(1);

      // Kill and wait for exit
      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Listeners should be cleared to prevent memory leaks
      expect(session.dataListeners.size).toBe(0);
      expect(session.exitListeners.size).toBe(0);
    });
  });

  describe('listener error isolation', () => {
    it('should continue notifying other data listeners when one throws', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      let listener1Called = false;
      let listener2Called = false;
      let listener3Called = false;

      // First listener throws
      manager.onData(session.id, () => {
        listener1Called = true;
        throw new Error('Listener 1 error');
      });

      // Second listener should still be called
      manager.onData(session.id, () => {
        listener2Called = true;
      });

      // Third listener should also be called
      manager.onData(session.id, () => {
        listener3Called = true;
      });

      manager.write(session.id, 'echo test\n');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(listener1Called).toBe(true);
      expect(listener2Called).toBe(true);
      expect(listener3Called).toBe(true);
    });

    it('should continue notifying other exit listeners when one throws', async () => {
      const session = manager.create({ command: ['/bin/sh'] });
      let listener1Called = false;
      let listener2Called = false;
      let listener3Called = false;

      // First listener throws
      manager.onExit(session.id, () => {
        listener1Called = true;
        throw new Error('Exit listener 1 error');
      });

      // Second listener should still be called
      manager.onExit(session.id, () => {
        listener2Called = true;
      });

      // Third listener should also be called
      manager.onExit(session.id, () => {
        listener3Called = true;
      });

      manager.kill(session.id);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(listener1Called).toBe(true);
      expect(listener2Called).toBe(true);
      expect(listener3Called).toBe(true);
    });

    it('should not crash PTY when all listeners throw', async () => {
      const session = manager.create({ command: ['/bin/sh'] });

      // All listeners throw
      manager.onData(session.id, () => {
        throw new Error('Error 1');
      });
      manager.onData(session.id, () => {
        throw new Error('Error 2');
      });

      // Write should not crash
      manager.write(session.id, 'echo test\n');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // PTY should still be functional
      expect(manager.get(session.id)?.state).toBe('running');
      const result = manager.write(session.id, 'echo still works\n');
      expect(result.success).toBe(true);
    });
  });

  describe('concurrent operations', () => {
    it('should handle concurrent PTY creation', async () => {
      const promises = Array.from({ length: 5 }, () =>
        Promise.resolve(manager.create({ command: ['/bin/sh'] }))
      );

      const sessions = await Promise.all(promises);
      const ids = sessions.map((s) => s.id);

      // All IDs should be unique
      expect(new Set(ids).size).toBe(5);
      expect(manager.list().length).toBe(5);
    });

    it('should handle concurrent writes to same PTY', async () => {
      const session = manager.create({ command: ['/bin/sh'] });

      const promises = Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(manager.write(session.id, `echo ${i}\n`))
      );

      const results = await Promise.all(promises);

      // All writes should succeed
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should handle concurrent resize operations', async () => {
      const session = manager.create({ command: ['/bin/sh'] });

      const promises = Array.from({ length: 5 }, (_, i) =>
        Promise.resolve(manager.resize(session.id, 80 + i * 10, 24 + i * 5))
      );

      const results = await Promise.all(promises);

      // All resizes should succeed
      expect(results.every((r) => r.success)).toBe(true);
    });
  });
});
