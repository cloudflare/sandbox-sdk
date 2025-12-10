/**
 * Session Manager Locking Tests
 * Tests for per-session mutex to prevent concurrent command execution
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoOpLogger } from '@repo/shared';
import { SessionManager } from '../../src/services/session-manager';

describe('SessionManager Locking', () => {
  let sessionManager: SessionManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-lock-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    sessionManager = new SessionManager(createNoOpLogger());
  });

  afterEach(async () => {
    await sessionManager.destroy();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('concurrent command serialization', () => {
    it('should serialize concurrent commands to the same session', async () => {
      const sessionId = 'test-session';
      const executionOrder: string[] = [];

      // Two commands that would interleave without locking
      // Each echoes a marker, sleeps briefly, then echoes completion
      const cmd1 = sessionManager
        .executeInSession(
          sessionId,
          'echo "START-1"; sleep 0.05; echo "END-1"',
          testDir
        )
        .then((result) => {
          executionOrder.push('cmd1-complete');
          return result;
        });

      const cmd2 = sessionManager
        .executeInSession(
          sessionId,
          'echo "START-2"; sleep 0.05; echo "END-2"',
          testDir
        )
        .then((result) => {
          executionOrder.push('cmd2-complete');
          return result;
        });

      const [result1, result2] = await Promise.all([cmd1, cmd2]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // With locking, commands are serialized - outputs should NOT interleave
      // Each command's output should contain its START and END together
      if (result1.success && result2.success) {
        const out1 = result1.data.stdout;
        const out2 = result2.data.stdout;

        // Command 1 output should have START-1 and END-1
        expect(out1).toContain('START-1');
        expect(out1).toContain('END-1');
        // Command 2 output should have START-2 and END-2
        expect(out2).toContain('START-2');
        expect(out2).toContain('END-2');
      }
    });

    it('should allow concurrent commands to different sessions', async () => {
      const startTimes: Record<string, number> = {};
      const endTimes: Record<string, number> = {};

      // Run commands in two different sessions concurrently
      const cmd1 = (async () => {
        startTimes['session1'] = Date.now();
        const result = await sessionManager.executeInSession(
          'session-1',
          'sleep 0.1',
          testDir
        );
        endTimes['session1'] = Date.now();
        return result;
      })();

      const cmd2 = (async () => {
        startTimes['session2'] = Date.now();
        const result = await sessionManager.executeInSession(
          'session-2',
          'sleep 0.1',
          testDir
        );
        endTimes['session2'] = Date.now();
        return result;
      })();

      await Promise.all([cmd1, cmd2]);

      // Both sessions should have started around the same time (parallel)
      const startDiff = Math.abs(
        startTimes['session1'] - startTimes['session2']
      );
      expect(startDiff).toBeLessThan(50); // Started within 50ms of each other

      // Total time should be ~100ms (parallel), not ~200ms (serial)
      const totalTime =
        Math.max(endTimes['session1'], endTimes['session2']) -
        Math.min(startTimes['session1'], startTimes['session2']);
      expect(totalTime).toBeLessThan(180); // Should be ~100ms with some overhead
    });
  });

  describe('session creation coordination', () => {
    it('should not create duplicate sessions under concurrent requests', async () => {
      const sessionId = 'concurrent-create-session';

      // Fire multiple concurrent requests that all try to create the same session
      const requests = Array(5)
        .fill(null)
        .map(() =>
          sessionManager.executeInSession(sessionId, 'echo "created"', testDir)
        );

      const results = await Promise.all(requests);

      // All should succeed
      for (const result of results) {
        expect(result.success).toBe(true);
      }

      // Only one session should exist
      const listResult = await sessionManager.listSessions();
      expect(listResult.success).toBe(true);
      if (listResult.success) {
        const matchingSessions = listResult.data.filter(
          (id) => id === sessionId
        );
        expect(matchingSessions.length).toBe(1);
      }
    });
  });

  describe('withSession atomic operations', () => {
    it('should execute multiple commands atomically', async () => {
      const sessionId = 'atomic-session';
      const executionLog: string[] = [];

      // Operation 1: Atomic multi-command sequence
      const op1 = sessionManager.withSession(
        sessionId,
        async (exec) => {
          executionLog.push('op1-start');
          await exec('echo "op1-cmd1"');
          await new Promise((r) => setTimeout(r, 50)); // Simulate work
          await exec('echo "op1-cmd2"');
          executionLog.push('op1-end');
          return 'op1-result';
        },
        testDir
      );

      // Operation 2: Tries to interleave
      const op2 = sessionManager.withSession(
        sessionId,
        async (exec) => {
          executionLog.push('op2-start');
          await exec('echo "op2-cmd1"');
          executionLog.push('op2-end');
          return 'op2-result';
        },
        testDir
      );

      const [result1, result2] = await Promise.all([op1, op2]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // With atomic locking, op2 cannot start until op1 finishes
      // So the log should be: op1-start, op1-end, op2-start, op2-end
      // (or vice versa if op2 wins the lock first)
      const op1StartIdx = executionLog.indexOf('op1-start');
      const op1EndIdx = executionLog.indexOf('op1-end');
      const op2StartIdx = executionLog.indexOf('op2-start');
      const op2EndIdx = executionLog.indexOf('op2-end');

      // Either op1 fully completes before op2 starts, or vice versa
      const op1BeforeOp2 = op1EndIdx < op2StartIdx;
      const op2BeforeOp1 = op2EndIdx < op1StartIdx;
      expect(op1BeforeOp2 || op2BeforeOp1).toBe(true);
    });

    it('should return the callback result on success', async () => {
      const result = await sessionManager.withSession(
        'result-session',
        async (exec) => {
          const cmdResult = await exec('echo "hello"');
          return cmdResult.stdout.trim();
        },
        testDir
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('hello');
      }
    });

    it('should handle callback errors gracefully', async () => {
      const result = await sessionManager.withSession<void>(
        'error-session',
        async (): Promise<void> => {
          throw new Error('Callback failed');
        },
        testDir
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('Callback failed');
      }
    });
  });

  describe('streaming execution locking', () => {
    it('should hold lock during foreground streaming until complete', async () => {
      const sessionId = 'stream-fg-session';
      const events: string[] = [];

      // Start foreground streaming command (holds lock)
      const streamPromise = sessionManager.executeStreamInSession(
        sessionId,
        'echo "stream-start"; sleep 0.1; echo "stream-end"',
        async (event) => {
          events.push(`stream-${event.type}`);
        },
        { cwd: testDir },
        'cmd-1',
        { background: false }
      );

      // Give streaming a moment to start
      await new Promise((r) => setTimeout(r, 20));

      // Try to run another command - should wait for stream to complete
      const execStart = Date.now();
      const execPromise = sessionManager.executeInSession(
        sessionId,
        'echo "exec-done"',
        testDir
      );

      const [streamResult, execResult] = await Promise.all([
        streamPromise,
        execPromise
      ]);
      const execDuration = Date.now() - execStart;

      expect(streamResult.success).toBe(true);
      expect(execResult.success).toBe(true);

      // exec should have waited for stream (~100ms sleep)
      expect(execDuration).toBeGreaterThan(80);
    });

    it('should release lock early for background streaming', async () => {
      const sessionId = 'stream-bg-session';

      // Start background streaming command (releases lock after start event)
      const streamResult = await sessionManager.executeStreamInSession(
        sessionId,
        'sleep 0.2; echo "bg-done"',
        async () => {},
        { cwd: testDir },
        'cmd-bg',
        { background: true }
      );

      expect(streamResult.success).toBe(true);

      // Immediately try another command - should NOT wait 200ms
      const execStart = Date.now();
      const execResult = await sessionManager.executeInSession(
        sessionId,
        'echo "exec-fast"',
        testDir
      );
      const execDuration = Date.now() - execStart;

      expect(execResult.success).toBe(true);
      // Should complete quickly since lock was released after start event
      expect(execDuration).toBeLessThan(150);
    });
  });
});
