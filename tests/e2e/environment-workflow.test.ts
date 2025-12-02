import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { ExecResult } from '@repo/shared';

/**
 * Environment Edge Case Tests
 *
 * Tests edge cases for environment and command execution.
 * Happy path tests (env vars, persistence, per-command env/cwd) are in comprehensive-workflow.test.ts.
 *
 * This file focuses on:
 * - Commands that read stdin (should not hang)
 */
describe('Environment Edge Cases', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  test('should handle commands that read stdin without hanging', async () => {
    // Test 1: cat with no arguments should exit immediately with EOF
    const catResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'cat'
      })
    });

    expect(catResponse.status).toBe(200);
    const catData = (await catResponse.json()) as ExecResult;
    expect(catData.success).toBe(true);
    expect(catData.stdout).toBe('');

    // Test 2: bash read command should return immediately
    const readResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'read -t 1 INPUT_VAR || echo "read returned"'
      })
    });

    expect(readResponse.status).toBe(200);
    const readData = (await readResponse.json()) as ExecResult;
    expect(readData.success).toBe(true);
    expect(readData.stdout).toContain('read returned');

    // Test 3: grep with no file should exit immediately
    const grepResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'grep "test" || true'
      })
    });

    expect(grepResponse.status).toBe(200);
    const grepData = (await grepResponse.json()) as ExecResult;
    expect(grepData.success).toBe(true);
  }, 90000);
});
