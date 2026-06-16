import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandSession } from '@repo/sandbox-execution';
import { createNoOpLogger } from '@repo/shared';
import { SessionManager } from '../../src/services/session-manager';

describe('SessionManager runtime integration', () => {
  let sessionManager: SessionManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-runtime-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    sessionManager = new SessionManager(createNoOpLogger());
  });

  afterEach(async () => {
    await sessionManager.destroy();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('creates persistent exec sessions through the execution runtime', async () => {
    const createSpy = vi.spyOn(CommandSession, 'create');

    const setResult = await sessionManager.executeInSession(
      'runtime-session',
      'export SESSION_RUNTIME_VALUE=from-runtime',
      { cwd: testDir }
    );
    const readResult = await sessionManager.executeInSession(
      'runtime-session',
      'printf "$SESSION_RUNTIME_VALUE"',
      { cwd: testDir }
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: testDir })
    );
    expect(setResult.success).toBe(true);
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.data.stdout).toBe('from-runtime');
    }
  });
});
