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

      // Two commands that would interleave without locking
      const cmd1 = sessionManager.executeInSession(
        sessionId,
        'echo "START-1"; sleep 0.05; echo "END-1"',
        testDir
      );

      const cmd2 = sessionManager.executeInSession(
        sessionId,
        'echo "START-2"; sleep 0.05; echo "END-2"',
        testDir
      );

      const [result1, result2] = await Promise.all([cmd1, cmd2]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // With locking, each command's output should be complete (not interleaved)
      if (result1.success && result2.success) {
        expect(result1.data.stdout).toContain('START-1');
        expect(result1.data.stdout).toContain('END-1');
        expect(result2.data.stdout).toContain('START-2');
        expect(result2.data.stdout).toContain('END-2');
      }
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
          await new Promise((r) => setTimeout(r, 50));
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

      // With atomic locking, one operation must fully complete before the other starts
      const op1StartIdx = executionLog.indexOf('op1-start');
      const op1EndIdx = executionLog.indexOf('op1-end');
      const op2StartIdx = executionLog.indexOf('op2-start');
      const op2EndIdx = executionLog.indexOf('op2-end');

      const op1BeforeOp2 = op1EndIdx < op2StartIdx;
      const op2BeforeOp1 = op2EndIdx < op1StartIdx;
      expect(op1BeforeOp2 || op2BeforeOp1).toBe(true);
    });
  });

  describe('streaming execution locking', () => {
    it('should hold lock during foreground streaming until complete', async () => {
      const sessionId = 'stream-fg-session';

      // Start foreground streaming command (holds lock)
      const streamPromise = sessionManager.executeStreamInSession(
        sessionId,
        'echo "stream-start"; sleep 0.1; echo "stream-end"',
        async () => {},
        { cwd: testDir },
        'cmd-1',
        { background: false }
      );

      // Give streaming a moment to start
      await new Promise((r) => setTimeout(r, 20));

      // Try to run another command - should wait for stream to complete
      const execPromise = sessionManager.executeInSession(
        sessionId,
        'echo "exec-done"',
        testDir
      );

      const [streamResult, execResult] = await Promise.all([
        streamPromise,
        execPromise
      ]);

      expect(streamResult.success).toBe(true);
      expect(execResult.success).toBe(true);
    });

    it('should release lock early for background streaming', async () => {
      const sessionId = 'stream-bg-session';

      // Start background streaming command (releases lock after start event)
      const streamResult = await sessionManager.executeStreamInSession(
        sessionId,
        'sleep 0.5; echo "bg-done"',
        async () => {},
        { cwd: testDir },
        'cmd-bg',
        { background: true }
      );

      expect(streamResult.success).toBe(true);

      // Should be able to run another command immediately (not blocked by 500ms sleep)
      const execResult = await sessionManager.executeInSession(
        sessionId,
        'echo "exec-fast"',
        testDir
      );

      expect(execResult.success).toBe(true);
    });
  });
});
