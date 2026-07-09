import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SandboxCommand } from '../../packages/shared/src/process-types';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

async function executeCommand(
  workerUrl: string,
  headers: Record<string, string>,
  command: SandboxCommand
): Promise<CommandResponse> {
  const response = await fetch(`${workerUrl}/api/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command })
  });

  expect(response.status).toBe(200);
  return (await response.json()) as CommandResponse;
}

describe('Stateless Execution Workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should run implicit exec calls without shared shell state', async () => {
    const testDir = sandbox!.uniquePath('stateless-state');
    const first = await executeCommand(workerUrl, headers, [
      '/bin/bash',
      '-lc',
      `mkdir -p '${testDir}' && export STATELESS_MARKER=present && cd '${testDir}' && printf '%s|%s' "$STATELESS_MARKER" "$PWD"`
    ]);

    expect(first.success).toBe(true);
    expect(first.stdout.trim()).toBe(`present|${testDir}`);

    const second = await executeCommand(workerUrl, headers, [
      '/bin/bash',
      '-lc',
      `printf '%s|%s' "\${STATELESS_MARKER:-missing}" "$PWD"`
    ]);

    expect(second.success).toBe(true);
    const [marker, cwd] = second.stdout.trim().split('|');
    expect(marker).toBe('missing');
    expect(cwd).not.toBe(testDir);
  }, 90000);

  test('should execute argv commands directly', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['printf', 'argv-ok'] })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as CommandResponse;
    expect(result.stdout).toBe('argv-ok');
    expect(result.exitCode).toBe(0);
  });

  test('should reject malformed execution options', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['true'], timeout: '1000' })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'timeout must be a number'
    });
  });

  test('should report execution timeouts', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: ['/bin/bash', '-lc', 'sleep 1'],
        timeout: 50
      })
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as CommandResponse;

    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.signal).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);
  }, 90000);
});
