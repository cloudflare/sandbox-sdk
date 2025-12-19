import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import { PtyManager } from '../../src/managers/pty-manager';

// Note: These tests require Bun.Terminal (introduced in Bun v1.3.5+)
// AND a working PTY device (not available in CI environments)
// PTY tests are skipped in CI - they will be tested in E2E tests where Docker
// provides a proper environment with PTY support.
const hasBunTerminal =
  typeof (Bun as { Terminal?: unknown }).Terminal !== 'undefined';
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const canRunPtyTests = hasBunTerminal && !isCI;

describe.skipIf(!canRunPtyTests)('PtyManager', () => {
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

  describe('list', () => {
    it('should return all sessions', () => {
      manager.create({ command: ['/bin/sh'] });
      manager.create({ command: ['/bin/sh'] });

      const list = manager.list();
      expect(list.length).toBe(2);
    });
  });

  describe('write', () => {
    it('should write data to PTY', () => {
      const session = manager.create({ command: ['/bin/sh'] });

      // Should not throw
      manager.write(session.id, 'echo hello\n');
    });
  });

  describe('resize', () => {
    it('should resize PTY', () => {
      const session = manager.create({ command: ['/bin/sh'] });
      manager.resize(session.id, 100, 50);

      const updated = manager.get(session.id);
      expect(updated?.cols).toBe(100);
      expect(updated?.rows).toBe(50);
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
  });
});
