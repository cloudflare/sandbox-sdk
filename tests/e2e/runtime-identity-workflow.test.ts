import { describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox
} from './helpers/global-sandbox';
import { waitForCondition } from './helpers/test-fixtures';
import type { RuntimeIdentityResponse } from './test-worker/types';

interface SandboxStateResponse {
  status: string;
}

describe('Runtime Identity E2E', () => {
  test('should keep identity stable while a runtime stays active', async () => {
    const sandbox = await createTestSandbox();

    try {
      const response1 = await fetch(
        `${sandbox.workerUrl}/api/runtime/identity`,
        {
          method: 'GET',
          headers: sandbox.headers()
        }
      );
      expect(response1.ok).toBe(true);

      const runtime1 = (await response1.json()) as RuntimeIdentityResponse;
      expect(runtime1.runtimeId).not.toBe('');

      const response2 = await waitForCondition(
        async () => {
          const response = await fetch(
            `${sandbox.workerUrl}/api/runtime/identity`,
            {
              method: 'GET',
              headers: sandbox.headers()
            }
          );

          if (!response.ok) {
            throw new Error(`Runtime identity not ready: ${response.status}`);
          }

          return response;
        },
        {
          timeout: 15000,
          interval: 500,
          errorMessage:
            'Runtime identity did not become available after idle restart'
        }
      );
      expect(response2.ok).toBe(true);

      const runtime2 = (await response2.json()) as RuntimeIdentityResponse;
      expect(runtime2).toEqual(runtime1);
    } finally {
      await cleanupTestSandbox(sandbox);
    }
  }, 120000);

  test('should keep returning a stable identity after an idle restart', async () => {
    const sandbox = await createTestSandbox({ sleepAfter: '3s' });

    try {
      const response1 = await fetch(
        `${sandbox.workerUrl}/api/runtime/identity`,
        {
          method: 'GET',
          headers: sandbox.headers()
        }
      );
      expect(response1.ok).toBe(true);

      const runtime1 = (await response1.json()) as RuntimeIdentityResponse;
      expect(runtime1.runtimeId).not.toBe('');

      const stateHeaders = { ...sandbox.headers() };
      delete stateHeaders['X-Sandbox-Sleep-After'];

      await new Promise((resolve) => setTimeout(resolve, 8000));

      const stateResponse = await fetch(`${sandbox.workerUrl}/api/state`, {
        method: 'GET',
        headers: stateHeaders
      });
      expect(stateResponse.ok).toBe(true);

      const state = (await stateResponse.json()) as SandboxStateResponse;
      expect(['stopped', 'stopped_with_code']).toContain(state.status);

      const response2 = await waitForCondition(
        async () => {
          const response = await fetch(
            `${sandbox.workerUrl}/api/runtime/identity`,
            {
              method: 'GET',
              headers: sandbox.headers()
            }
          );

          if (!response.ok) {
            const body = await response.text();
            throw new Error(
              `Runtime identity not ready after restart: status=${response.status} body=${body}`
            );
          }

          return response;
        },
        {
          timeout: 15000,
          interval: 500,
          errorMessage:
            'Runtime identity did not become available after idle restart'
        }
      );
      expect(response2.ok).toBe(true);

      const restarted1 = (await response2.json()) as RuntimeIdentityResponse;
      expect(restarted1.runtimeId).not.toBe('');

      const response3 = await fetch(
        `${sandbox.workerUrl}/api/runtime/identity`,
        {
          method: 'GET',
          headers: sandbox.headers()
        }
      );
      expect(response3.ok).toBe(true);

      const restarted2 = (await response3.json()) as RuntimeIdentityResponse;
      expect(restarted2).toEqual(restarted1);
    } finally {
      await cleanupTestSandbox(sandbox);
    }
  }, 60000);
});
