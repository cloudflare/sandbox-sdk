/**
 * E2E Test: Parallel Context Creation Crash Reproduction
 *
 * This test reproduces issue #276 where parallel context operations crash the container.
 * The issue occurs when creating/deleting multiple contexts simultaneously.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import type { CodeContext } from '@repo/shared';

describe('Parallel Context Operations (Issue #276)', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createPythonHeaders(createUniqueSession());
  }, 120000);

  // Helper to create context
  async function createContext(language: 'python' | 'javascript') {
    const res = await fetch(`${workerUrl}/api/code/context/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ language })
    });
    if (res.status !== 200) {
      const error = await res.text();
      throw new Error(`Failed to create context: ${res.status} ${error}`);
    }
    return (await res.json()) as CodeContext;
  }

  // Helper to delete context
  async function deleteContext(contextId: string) {
    const res = await fetch(`${workerUrl}/api/code/context/${contextId}`, {
      method: 'DELETE',
      headers
    });
    return res;
  }

  test('should handle parallel context creation without crashing', async () => {
    // Create 5 contexts in parallel
    const contextCount = 5;
    console.log(`Creating ${contextCount} contexts in parallel...`);

    const createPromises = Array.from({ length: contextCount }, (_, i) => {
      console.log(`Initiating context ${i + 1} creation...`);
      return createContext('python');
    });

    const results = await Promise.allSettled(createPromises);

    // Check results
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    console.log(`Success: ${succeeded.length}, Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.error('Failed context creations:');
      failed.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(`  Context ${i + 1}: ${result.reason}`);
        }
      });
    }

    // All should succeed
    expect(failed.length).toBe(0);
    expect(succeeded.length).toBe(contextCount);

    // Cleanup - delete all contexts in parallel
    const contexts = succeeded.map((r) =>
      r.status === 'fulfilled' ? r.value : null
    );
    const validContexts = contexts.filter(
      (ctx): ctx is CodeContext => ctx !== null
    );

    console.log(`Cleaning up ${validContexts.length} contexts in parallel...`);
    await Promise.all(validContexts.map((ctx) => deleteContext(ctx.id)));
  }, 120000);

  test('should handle parallel context deletion without crashing', async () => {
    // Create 5 contexts sequentially first
    const contextCount = 5;
    const contexts: CodeContext[] = [];

    console.log(`Creating ${contextCount} contexts sequentially...`);
    for (let i = 0; i < contextCount; i++) {
      const ctx = await createContext('javascript');
      contexts.push(ctx);
      console.log(`Created context ${i + 1}/${contextCount}: ${ctx.id}`);
    }

    // Now delete them all in parallel
    console.log(`Deleting ${contextCount} contexts in parallel...`);
    const deletePromises = contexts.map((ctx) => deleteContext(ctx.id));
    const results = await Promise.allSettled(deletePromises);

    // Check results
    const succeeded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 200
    );
    const failed = results.filter(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 200)
    );

    console.log(`Success: ${succeeded.length}, Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.error('Failed context deletions:');
      failed.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(`  Context ${i + 1}: ${result.reason}`);
        }
      });
    }

    // All should succeed
    expect(failed.length).toBe(0);
    expect(succeeded.length).toBe(contextCount);
  }, 120000);

  test('should handle mixed parallel create and delete operations', async () => {
    // Create some contexts first
    console.log('Creating initial contexts...');
    const initialContexts: CodeContext[] = [];
    for (let i = 0; i < 3; i++) {
      initialContexts.push(await createContext('python'));
    }

    // Now mix operations: create 3 new contexts while deleting 3 old ones
    console.log('Performing mixed parallel operations...');
    const mixedPromises = [
      ...initialContexts.map((ctx) => deleteContext(ctx.id)),
      ...Array.from({ length: 3 }, () => createContext('python'))
    ];

    const results = await Promise.allSettled(mixedPromises);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    console.log(`Success: ${succeeded.length}, Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.error('Failed operations:');
      failed.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.error(`  Operation ${i + 1}: ${result.reason}`);
        }
      });
    }

    // Cleanup any created contexts
    const newContexts = results
      .filter(
        (r): r is PromiseFulfilledResult<CodeContext> =>
          r.status === 'fulfilled' &&
          typeof r.value === 'object' &&
          'id' in r.value
      )
      .map((r) => r.value);

    if (newContexts.length > 0) {
      await Promise.all(newContexts.map((ctx) => deleteContext(ctx.id)));
    }
  }, 120000);
});
