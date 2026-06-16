import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import type { Pty } from '../../src/pty';
import { SessionManager } from '../../src/services/session-manager';

const SESSION_ID = 'pty-compat-test-session';

describe('SessionManager PTY compatibility', () => {
  let sessionManager: SessionManager;
  let pty: Pty | undefined;

  beforeEach(() => {
    sessionManager = new SessionManager(createNoOpLogger());
    pty = undefined;
  });

  afterEach(async () => {
    if (pty) {
      await pty.destroy().catch(() => {});
    }
    await sessionManager.destroy();
  });

  async function collectPtyOutput(
    p: Pty,
    command: string,
    waitMs = 500
  ): Promise<string> {
    const chunks: Uint8Array[] = [];
    const disposable = p.onData((data) => chunks.push(data));
    p.write(command);
    await Bun.sleep(waitMs);
    disposable.dispose();
    return Buffer.concat(chunks).toString('utf8');
  }

  it('does not create a command session when opening a PTY', async () => {
    const ptyResult = await sessionManager.getPty(SESSION_ID);
    if (!ptyResult.success) throw new Error(ptyResult.error.message);
    pty = ptyResult.data;

    const managerInternals = sessionManager as unknown as {
      sessions: Map<string, unknown>;
    };
    expect(managerInternals.sessions.has(SESSION_ID)).toBe(false);
  });

  it('does not inherit command-session environment or cwd', async () => {
    const setupResult = await sessionManager.executeInSession(
      SESSION_ID,
      'export PTY_TEST_VAR=hello_from_session && cd /tmp'
    );
    expect(setupResult.success).toBe(true);

    const ptyResult = await sessionManager.getPty(SESSION_ID);
    if (!ptyResult.success) throw new Error(ptyResult.error.message);
    pty = ptyResult.data;

    await Bun.sleep(200);

    const output = await collectPtyOutput(
      pty,
      `printf "var:%s cwd:%s\\n" "\${PTY_TEST_VAR:-missing}" "$PWD"\n`
    );
    expect(output).toContain('var:missing');
    expect(output).not.toContain('cwd:/tmp');
  });

  it('does not destroy terminal resources when deleting command sessions', async () => {
    const setupResult = await sessionManager.executeInSession(
      SESSION_ID,
      'printf "session-ready"'
    );
    expect(setupResult.success).toBe(true);

    const ptyResult = await sessionManager.getPty(SESSION_ID);
    if (!ptyResult.success) throw new Error(ptyResult.error.message);
    pty = ptyResult.data;

    const deleteResult = await sessionManager.deleteSession(SESSION_ID);
    expect(deleteResult.success).toBe(true);

    expect(() => pty?.write('printf "terminal-still-open\\n"\n')).not.toThrow();
  });
});
