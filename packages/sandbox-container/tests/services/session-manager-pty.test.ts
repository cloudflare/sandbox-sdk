/**
 * Session Manager PTY Tests
 * Tests that env vars and working directory set on a session are correctly
 * inherited by a PTY opened from that session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import type { Pty } from '../../src/pty';
import { SessionManager } from '../../src/services/session-manager';

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
    if (!ptyResult.success) throw new Error(ptyResult.error.message);
    pty = ptyResult.data;

    await Bun.sleep(200);

    const output = await collectPtyOutput(
      pty,
      'echo "PTY_VAR=$PTY_TEST_VAR"\n'
    );
    expect(output).toContain('PTY_VAR=hello_from_session');

    // If null-byte splitting is broken, all env vars merge into one
    // entry and only the first var is parsed correctly.
    const pathOutput = await collectPtyOutput(
      pty,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell variable syntax
      'echo "HAS_PATH=${PATH:+yes}"\n'
    );
    expect(pathOutput).toContain('HAS_PATH=yes');
  });

  it('should inherit working directory changes made in the session', async () => {
    const execResult = await sessionManager.executeInSession(
      SESSION_ID,
      'cd /tmp'
    );
    expect(execResult.success).toBe(true);

    const ptyResult = await sessionManager.getPty(SESSION_ID);
    if (!ptyResult.success) throw new Error(ptyResult.error.message);
    pty = ptyResult.data;

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
    if (!ptyResult.success) throw new Error(ptyResult.error.message);
    pty = ptyResult.data;

    await Bun.sleep(200);

    const output = await collectPtyOutput(
      pty,
      'echo "$PTY_MULTI_A $PTY_MULTI_B"\n'
    );
    expect(output).toContain('alpha beta');

    // If env parsing fails, all vars merge into one unparsable
    // entry — verify system env vars also survived parsing.
    const homeOutput = await collectPtyOutput(pty, 'echo "HOME=$HOME"\n');
    expect(homeOutput).toMatch(/HOME=\//);
  });
});
