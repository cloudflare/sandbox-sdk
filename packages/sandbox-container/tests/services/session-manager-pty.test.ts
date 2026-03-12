/**
 * Session Manager PTY Tests
 * Tests that env vars and working directory set on a session are correctly
 * inherited by a PTY opened from that session (regression for null-byte stripping).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import { SessionManager } from '../../src/services/session-manager';
import type { Pty } from '../../src/pty';

const SESSION_ID = 'pty-env-test-session';

describe('SessionManager PTY env inheritance', () => {
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

  it('should inherit env vars set via setEnvVars() before getPty()', async () => {
    const setResult = await sessionManager.setEnvVars(SESSION_ID, {
      PTY_TEST_VAR: 'hello_from_session'
    });
    expect(setResult.success).toBe(true);

    const ptyResult = await sessionManager.getPty(SESSION_ID);
    expect(ptyResult.success).toBe(true);
    pty = ptyResult.data!;

    await Bun.sleep(200); // wait for PTY shell to initialize

    const output = await collectPtyOutput(pty, 'echo "PTY_VAR=$PTY_TEST_VAR"\n');
    expect(output).toContain('PTY_VAR=hello_from_session');
  });

  it('should inherit working directory changes made in the session', async () => {
    const execResult = await sessionManager.executeInSession(
      SESSION_ID,
      'cd /tmp',
      '/root'
    );
    expect(execResult.success).toBe(true);

    const ptyResult = await sessionManager.getPty(SESSION_ID);
    expect(ptyResult.success).toBe(true);
    pty = ptyResult.data!;

    await Bun.sleep(200);

    const output = await collectPtyOutput(pty, 'pwd\n');
    expect(output).toContain('/tmp');
  });

  it('should inherit multiple env vars set before getPty()', async () => {
    const setResult = await sessionManager.setEnvVars(SESSION_ID, {
      PTY_MULTI_A: 'alpha',
      PTY_MULTI_B: 'beta'
    });
    expect(setResult.success).toBe(true);

    const ptyResult = await sessionManager.getPty(SESSION_ID);
    expect(ptyResult.success).toBe(true);
    pty = ptyResult.data!;

    await Bun.sleep(200);

    const output = await collectPtyOutput(
      pty,
      'echo "$PTY_MULTI_A $PTY_MULTI_B"\n'
    );
    expect(output).toContain('alpha beta');
  });
});
