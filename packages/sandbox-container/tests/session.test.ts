/**
 * Session Tests - FIFO-based persistent shell execution
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';

describe('Session', () => {
  let session: Session;
  let testDir: string;

  beforeEach(async () => {
    // Create test directory
    testDir = join(tmpdir(), `session-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up session and test directory
    if (session) {
      try {
        await session.destroy();
      } catch (error) {
        // Ignore errors during cleanup
      }
    }

    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  describe('initialization', () => {
    it('should initialize session successfully', async () => {
      session = new Session({
        id: 'test-session-1',
        cwd: testDir
      });

      await session.initialize();

      expect(session.isReady()).toBe(true);
    });

    it('should create session with custom environment variables', async () => {
      session = new Session({
        id: 'test-session-2',
        cwd: testDir,
        env: {
          TEST_VAR: 'test-value'
        }
      });

      await session.initialize();

      const result = await session.exec('echo $TEST_VAR');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test-value');
    });

    it('should create session directory', async () => {
      session = new Session({
        id: 'test-session-3',
        cwd: testDir
      });

      await session.initialize();

      // Session directory should be created (we can't easily check without accessing private fields)
      expect(session.isReady()).toBe(true);
    });
  });

  describe('exec', () => {
    beforeEach(async () => {
      session = new Session({
        id: 'test-exec',
        cwd: testDir
      });
      await session.initialize();
    });

    it('should execute simple command successfully', async () => {
      const result = await session.exec('echo "Hello World"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Hello World');
      expect(result.stderr).toBe('');
      expect(result.command).toBe('echo "Hello World"');
      expect(result.duration).toBeGreaterThan(0);
      expect(result.timestamp).toBeDefined();
    });

    it('should capture stderr correctly', async () => {
      const result = await session.exec('echo "Error message" >&2');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('Error message');
    });

    it('should capture both stdout and stderr', async () => {
      const result = await session.exec('echo "stdout"; echo "stderr" >&2');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('stdout');
      expect(result.stderr.trim()).toBe('stderr');
    });

    it('should return non-zero exit code for failed commands', async () => {
      // Use a command that fails without exiting the shell
      const result = await session.exec('false');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('should handle command not found', async () => {
      const result = await session.exec('nonexistentcommand123');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('not found');
    });

    it('should maintain state across commands (persistent shell)', async () => {
      // Set a variable
      const result1 = await session.exec('TEST_VAR="persistent"');
      expect(result1.exitCode).toBe(0);

      // Read the variable in a subsequent command
      const result2 = await session.exec('echo $TEST_VAR');
      expect(result2.exitCode).toBe(0);
      expect(result2.stdout.trim()).toBe('persistent');
    });

    it('should maintain working directory across commands', async () => {
      // Create a subdirectory and change to it
      const result1 = await session.exec('mkdir -p subdir && cd subdir');
      expect(result1.exitCode).toBe(0);

      // Verify we're still in the subdirectory
      const result2 = await session.exec('pwd');
      expect(result2.exitCode).toBe(0);
      expect(result2.stdout.trim()).toContain('subdir');
    });

    it('should override cwd temporarily when option provided', async () => {
      // Create a subdirectory
      await session.exec('mkdir -p tempdir');

      // Execute command in subdirectory
      const result = await session.exec('pwd', {
        cwd: join(testDir, 'tempdir')
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toContain('tempdir');

      // Verify original directory is restored
      const result2 = await session.exec('pwd');
      expect(result2.exitCode).toBe(0);
      // On macOS, /var is a symlink to /private/var, so normalize paths for comparison
      const normalizedResult = result2.stdout.trim().replace(/^\/private/, '');
      const normalizedTestDir = testDir.replace(/^\/private/, '');
      expect(normalizedResult).toBe(normalizedTestDir);
    });

    it('should handle multiline output', async () => {
      const result = await session.exec(
        'echo "line 1"; echo "line 2"; echo "line 3"'
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('line 1\nline 2\nline 3');
    });

    it('should handle long output', async () => {
      // Generate ~1KB of output
      const result = await session.exec('yes "test line" | head -n 100');

      expect(result.exitCode).toBe(0);
      expect(
        result.stdout.split('\n').filter((l) => l === 'test line')
      ).toHaveLength(100);
    });

    it('should handle output within size limit', async () => {
      // Generate ~5KB of output (well below the 10MB default)
      const result = await session.exec(
        'yes "test line with some text" | head -n 500'
      );

      expect(result.exitCode).toBe(0);
      const lines = result.stdout
        .split('\n')
        .filter((l) => l === 'test line with some text');
      expect(lines.length).toBe(500);
    });

    it('should reject output that exceeds max size', async () => {
      // Create session with 1KB limit
      const smallSession = new Session({
        id: 'small-output-session',
        cwd: testDir,
        maxOutputSizeBytes: 1024 // 1KB
      });
      await smallSession.initialize();

      try {
        // Try to generate >1KB of output (~12KB)
        await smallSession.exec(
          'yes "test line with text here" | head -n 1000'
        );
        expect.unreachable('Should have thrown an error for oversized output');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Output too large');
        expect((error as Error).message).toContain('1024');
      } finally {
        await smallSession.destroy();
      }
    });

    it('should handle commands with special characters', async () => {
      const result = await session.exec('echo "Hello $USER! @#$%^&*()"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello');
      expect(result.stdout).toContain('@#$%^&*()');
    });

    it('should handle shell pipes and redirects', async () => {
      const result = await session.exec('echo "test" | tr a-z A-Z');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('TEST');
    });

    it('should handle shell functions', async () => {
      // Define a function
      const result1 = await session.exec(
        'my_func() { echo "function works"; }'
      );
      expect(result1.exitCode).toBe(0);

      // Call the function
      const result2 = await session.exec('my_func');
      expect(result2.exitCode).toBe(0);
      expect(result2.stdout.trim()).toBe('function works');
    });
  });

  describe('execStream', () => {
    beforeEach(async () => {
      session = new Session({
        id: 'test-stream',
        cwd: testDir
      });
      await session.initialize();
    });

    it('should stream command output', async () => {
      const events: any[] = [];

      for await (const event of session.execStream(
        'echo "Hello"; echo "World"'
      )) {
        events.push(event);
      }

      // Should have start, stdout events, and complete
      expect(events.length).toBeGreaterThanOrEqual(3);

      // First event should be start
      expect(events[0].type).toBe('start');
      expect(events[0].command).toBe('echo "Hello"; echo "World"');

      // Last event should be complete
      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('complete');
      expect(lastEvent.exitCode).toBe(0);

      // Should have stdout events
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(0);
    });

    it('should stream stderr separately', async () => {
      const events: any[] = [];

      for await (const event of session.execStream(
        'echo "out"; echo "err" >&2'
      )) {
        events.push(event);
      }

      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const stderrEvents = events.filter((e) => e.type === 'stderr');

      expect(stdoutEvents.length).toBeGreaterThan(0);
      expect(stderrEvents.length).toBeGreaterThan(0);

      // Verify data
      expect(stdoutEvents.some((e) => e.data.includes('out'))).toBe(true);
      expect(stderrEvents.some((e) => e.data.includes('err'))).toBe(true);
    });

    it('should maintain session state during streaming', async () => {
      // Set a variable
      await session.exec('STREAM_VAR="stream-test"');

      // Stream command that uses the variable
      const events: any[] = [];
      for await (const event of session.execStream('echo $STREAM_VAR')) {
        events.push(event);
      }

      // Should complete successfully
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent.exitCode).toBe(0);

      // Should have correct output
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const output = stdoutEvents.map((e) => e.data).join('');
      expect(output.trim()).toBe('stream-test');
    });

    it('should handle errors during streaming', async () => {
      const events: any[] = [];

      for await (const event of session.execStream('nonexistentcommand456')) {
        events.push(event);
      }

      // Should have error or complete with non-zero exit code
      const completeEvent = events.find((e) => e.type === 'complete');
      const errorEvent = events.find((e) => e.type === 'error');

      expect(completeEvent || errorEvent).toBeDefined();

      if (completeEvent) {
        expect(completeEvent.exitCode).not.toBe(0);
      }
    });
  });

  describe('destroy', () => {
    it('should cleanup session resources', async () => {
      session = new Session({
        id: 'test-destroy',
        cwd: testDir
      });

      await session.initialize();
      expect(session.isReady()).toBe(true);

      await session.destroy();

      expect(session.isReady()).toBe(false);
    });

    it('should be safe to call destroy multiple times', async () => {
      session = new Session({
        id: 'test-destroy-multiple',
        cwd: testDir
      });

      await session.initialize();
      await session.destroy();
      await session.destroy(); // Should not throw

      expect(session.isReady()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should throw error when executing in destroyed session', async () => {
      session = new Session({
        id: 'test-error-1',
        cwd: testDir
      });

      await session.initialize();
      await session.destroy();

      try {
        await session.exec('echo test');
        expect.unreachable('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('not ready');
      }
    });

    it('should throw error when executing before initialization', async () => {
      session = new Session({
        id: 'test-error-2',
        cwd: testDir
      });

      try {
        await session.exec('echo test');
        expect.unreachable('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('not ready');
      }
    });

    it('should handle invalid cwd gracefully', async () => {
      session = new Session({
        id: 'test-error-3',
        cwd: testDir
      });

      await session.initialize();

      const result = await session.exec('echo test', {
        cwd: '/nonexistent/path/that/does/not/exist'
      });

      // Should fail to change directory
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Failed to change directory');
    });
  });

  describe('FIFO cleanup', () => {
    it('should cleanup FIFO pipes after command execution', async () => {
      session = new Session({
        id: 'test-fifo-cleanup',
        cwd: testDir
      });

      await session.initialize();

      // Execute a command
      await session.exec('echo test');

      // FIFO pipes should be cleaned up (can't easily verify without accessing private session dir)
      // But we can verify the session is still ready
      expect(session.isReady()).toBe(true);

      // Execute another command to ensure no leftover pipes interfere
      const result = await session.exec('echo test2');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test2');
    });
  });

  describe('binary prefix handling', () => {
    it('should correctly parse output with newlines', async () => {
      session = new Session({
        id: 'test-binary-prefix',
        cwd: testDir
      });

      await session.initialize();

      const result = await session.exec('echo "line1"; echo "line2"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('line1\nline2');
    });

    it('should handle empty output', async () => {
      session = new Session({
        id: 'test-empty-output',
        cwd: testDir
      });

      await session.initialize();

      const result = await session.exec('true');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('timeout handling', () => {
    it('should timeout long-running commands', async () => {
      // Create session with 1 second timeout
      session = new Session({
        id: 'test-timeout',
        cwd: testDir,
        commandTimeoutMs: 1000 // 1 second
      });

      await session.initialize();

      try {
        // Sleep for 3 seconds (longer than timeout)
        await session.exec('sleep 3');
        expect.unreachable('Should have thrown a timeout error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('timeout');
        expect((error as Error).message).toContain('1000ms');
      }
    });

    it('should complete fast commands within timeout', async () => {
      // Create session with 1 second timeout
      session = new Session({
        id: 'test-timeout-fast',
        cwd: testDir,
        commandTimeoutMs: 1000 // 1 second
      });

      await session.initialize();

      // Execute a fast command that completes well within timeout
      const result = await session.exec('echo "fast command"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('fast command');
    });
  });
});
