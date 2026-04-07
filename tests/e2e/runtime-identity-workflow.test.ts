import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import type { RuntimeIdentityResponse } from './test-worker/types';

describe('Runtime Identity E2E', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  test('should keep identity stable until the sandbox is recreated', async () => {
    if (!sandbox) {
      throw new Error('Sandbox was not initialized');
    }

    const response1 = await fetch(`${workerUrl}/api/runtime/identity`, {
      method: 'GET',
      headers: sandbox.headers()
    });
    expect(response1.ok).toBe(true);

    const runtime1 = (await response1.json()) as RuntimeIdentityResponse;

    const response2 = await fetch(`${workerUrl}/api/runtime/identity`, {
      method: 'GET',
      headers: sandbox.headers()
    });
    expect(response2.ok).toBe(true);

    const runtime2 = (await response2.json()) as RuntimeIdentityResponse;
    expect(runtime2).toEqual(runtime1);

    await cleanupTestSandbox(sandbox);

    const recreateResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: sandbox.headers(),
      body: JSON.stringify({ command: 'echo ready' })
    });
    expect(recreateResponse.ok).toBe(true);

    const response3 = await fetch(`${workerUrl}/api/runtime/identity`, {
      method: 'GET',
      headers: sandbox.headers()
    });
    expect(response3.ok).toBe(true);

    const runtime3 = (await response3.json()) as RuntimeIdentityResponse;
    expect(runtime3.runtimeId).not.toBe(runtime1.runtimeId);
  }, 120000);
});
