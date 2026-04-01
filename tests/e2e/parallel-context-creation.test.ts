/**
 * E2E Test: Parallel context creation (issue #276)
 *
 * Verifies that creating multiple code contexts in parallel does not
 * serialize or crash the container. Before the fix, requests beyond
 * the pre-warmed pool size queued behind a per-language mutex held
 * during process spawning, causing a staircase pattern and timeouts.
 */

import type { CodeContext } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

describe('Parallel Context Creation (issue #276)', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox({ type: 'python' });
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);

  async function createContext(
    language: 'python' | 'javascript'
  ): Promise<{ status: number; body: any; elapsed: number }> {
    const start = Date.now();
    const res = await fetch(`${workerUrl}/api/code/context/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ language })
    });
    const elapsed = Date.now() - start;
    const body = await res.json();
    return { status: res.status, body, elapsed };
  }

  async function deleteContext(contextId: string): Promise<void> {
    await fetch(`${workerUrl}/api/code/context/${contextId}`, {
      method: 'DELETE',
      headers
    });
  }

  test('6 parallel JS context creations should all succeed', async () => {
    const PARALLEL = 6;

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () => createContext('javascript'))
    );

    const succeeded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 200
    );
    expect(succeeded.length).toBe(PARALLEL);

    for (const r of succeeded) {
      const ctx = (r as PromiseFulfilledResult<any>).value.body as CodeContext;
      await deleteContext(ctx.id);
    }
  }, 60000);

  test('parallel JS and Python context creations should not block each other', async () => {
    const start = Date.now();

    const results = await Promise.allSettled([
      createContext('javascript'),
      createContext('javascript'),
      createContext('javascript'),
      createContext('python'),
      createContext('python'),
      createContext('python')
    ]);

    const elapsed = Date.now() - start;

    const succeeded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 200
    );
    expect(succeeded.length).toBe(6);

    // JS and Python use separate mutexes/semaphores, so cross-language
    // requests run fully in parallel. Wall time should be similar to
    // single-language parallel, not double.
    // Use a generous 30s threshold — the point is it completes at all
    // without timeouts or 500s.
    expect(elapsed).toBeLessThan(30000);

    for (const r of succeeded) {
      const ctx = (r as PromiseFulfilledResult<any>).value.body as CodeContext;
      await deleteContext(ctx.id);
    }
  }, 60000);

  test('parallel context deletions should all succeed', async () => {
    const COUNT = 5;

    // Create sequentially
    const contexts: CodeContext[] = [];
    for (let i = 0; i < COUNT; i++) {
      const result = await createContext('javascript');
      expect(result.status).toBe(200);
      contexts.push(result.body as CodeContext);
    }

    // Delete in parallel
    const results = await Promise.allSettled(
      contexts.map((ctx) => deleteContext(ctx.id))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBe(COUNT);
  }, 60000);
});
