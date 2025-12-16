/**
 * E2E Test: Code Interpreter Workflow
 *
 * Tests the complete Code Interpreter feature including:
 * - Context management (create, list, delete)
 * - Python code execution with state persistence
 * - JavaScript/Node.js code execution with state persistence
 * - Streaming execution output (runCodeStream)
 * - Context isolation between languages
 * - Multi-language workflows
 * - Error handling for invalid code and missing contexts
 *
 * These tests validate the README "Data Analysis with Code Interpreter" examples
 * and ensure the code interpreter works end-to-end in a real container environment.
 *
 */

import type { CodeContext, ExecutionResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';
import type { ErrorResponse } from './test-worker/types';

// Transport modes to test
const transportModes = [
  { name: 'HTTP', useWebSocket: false },
  { name: 'WebSocket', useWebSocket: true }
];

describe.each(transportModes)(
  'Code Interpreter Workflow (E2E) ($name transport)',
  ({ useWebSocket }) => {
    let workerUrl: string;
    let headers: Record<string, string>;

    beforeAll(async () => {
      const sandbox = await getSharedSandbox();
      workerUrl = sandbox.workerUrl;
      const baseHeaders = sandbox.createPythonHeaders(createUniqueSession());
      headers = useWebSocket
        ? { ...baseHeaders, 'X-Use-WebSocket': 'true' }
        : baseHeaders;
    }, 120000);

    // Helper to create context
    async function createContext(language: 'python' | 'javascript') {
      const res = await fetch(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language })
      });
      expect(res.status).toBe(200);
      return (await res.json()) as CodeContext;
    }

    // Helper to execute code
    async function executeCode(context: CodeContext, code: string) {
      const res = await fetch(`${workerUrl}/api/code/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code, options: { context } })
      });
      expect(res.status).toBe(200);
      return (await res.json()) as ExecutionResult;
    }

    // Helper to delete context
    async function deleteContext(contextId: string) {
      return fetch(`${workerUrl}/api/code/context/${contextId}`, {
        method: 'DELETE',
        headers
      });
    }

    // ============================================================================
    // Test 1: Context Lifecycle (create, list, delete)
    // ============================================================================

    test('context lifecycle: create, list, and delete contexts', async () => {
      // Create Python context
      const pythonCtx = await createContext('python');
      expect(pythonCtx.id).toBeTruthy();
      expect(pythonCtx.language).toBe('python');

      // Create JavaScript context
      const jsCtx = await createContext('javascript');
      expect(jsCtx.id).toBeTruthy();
      expect(jsCtx.language).toBe('javascript');
      expect(jsCtx.id).not.toBe(pythonCtx.id);

      // List all contexts - should contain both
      const listResponse = await fetch(`${workerUrl}/api/code/context/list`, {
        method: 'GET',
        headers
      });
      expect(listResponse.status).toBe(200);
      const contexts = (await listResponse.json()) as CodeContext[];
      expect(contexts.length).toBeGreaterThanOrEqual(2);
      const contextIds = contexts.map((ctx) => ctx.id);
      expect(contextIds).toContain(pythonCtx.id);
      expect(contextIds).toContain(jsCtx.id);

      // Delete Python context
      const deleteResponse = await deleteContext(pythonCtx.id);
      expect(deleteResponse.status).toBe(200);
      const deleteData = (await deleteResponse.json()) as { success: boolean };
      expect(deleteData.success).toBe(true);

      // Verify context is removed from list
      const listAfterDelete = await fetch(
        `${workerUrl}/api/code/context/list`,
        {
          method: 'GET',
          headers
        }
      );
      const contextsAfter = (await listAfterDelete.json()) as CodeContext[];
      expect(contextsAfter.map((c) => c.id)).not.toContain(pythonCtx.id);
      expect(contextsAfter.map((c) => c.id)).toContain(jsCtx.id);

      // Cleanup
      await deleteContext(jsCtx.id);
    }, 120000);

    // ============================================================================
    // Test 2: Python Workflow (execute, state persistence, errors)
    // ============================================================================

    test('Python workflow: execute, maintain state, handle errors', async () => {
      const ctx = await createContext('python');

      // Simple execution
      const exec1 = await executeCode(ctx, 'print("Hello from Python!")');
      expect(exec1.code).toBe('print("Hello from Python!")');
      expect(exec1.logs.stdout.join('')).toContain('Hello from Python!');
      expect(exec1.error).toBeUndefined();

      // Set variables for state persistence
      const exec2 = await executeCode(ctx, 'x = 42\ny = 10');
      expect(exec2.error).toBeUndefined();

      // Verify state persists across executions
      const exec3 = await executeCode(ctx, 'result = x + y\nprint(result)');
      expect(exec3.logs.stdout.join('')).toContain('52');
      expect(exec3.error).toBeUndefined();

      // Error handling - division by zero
      const exec4 = await executeCode(ctx, 'x = 1 / 0');
      expect(exec4.error).toBeDefined();
      expect(exec4.error!.name).toContain('Error');
      expect(exec4.error!.message || exec4.error!.traceback).toContain(
        'division'
      );

      // Cleanup
      await deleteContext(ctx.id);
    }, 120000);

    // ============================================================================
    // Test 3: JavaScript Workflow (execute, state, top-level await, IIFE, errors)
    // ============================================================================

    test('JavaScript workflow: execute, state, top-level await, IIFE, errors', async () => {
      const ctx = await createContext('javascript');

      // Simple execution
      const exec1 = await executeCode(
        ctx,
        'console.log("Hello from JavaScript!");'
      );
      expect(exec1.logs.stdout.join('')).toContain('Hello from JavaScript!');
      expect(exec1.error).toBeUndefined();

      // State persistence with global
      await executeCode(ctx, 'global.counter = 0;');
      const exec2 = await executeCode(ctx, 'console.log(++global.counter);');
      expect(exec2.logs.stdout.join('')).toContain('1');

      // Top-level await - basic
      const exec3 = await executeCode(
        ctx,
        'const result = await Promise.resolve(42);\nresult'
      );
      expect(exec3.error).toBeUndefined();
      expect(exec3.results![0].text).toContain('42');

      // Top-level await - multiple awaits returning last expression
      const exec4 = await executeCode(
        ctx,
        `
const a = await Promise.resolve(10);
const b = await Promise.resolve(20);
a + b
`.trim()
      );
      expect(exec4.error).toBeUndefined();
      expect(exec4.results![0].text).toContain('30');

      // Top-level await - async error handling
      const exec5 = await executeCode(
        ctx,
        'await Promise.reject(new Error("async error"))'
      );
      expect(exec5.error).toBeDefined();
      expect(exec5.error!.message || exec5.logs.stderr.join('')).toContain(
        'async error'
      );

      // Top-level await - LLM-generated pattern with delay
      const exec6 = await executeCode(
        ctx,
        `
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
await delay(10);
const data = { status: 'success', value: 123 };
data
`.trim()
      );
      expect(exec6.error).toBeUndefined();
      const resultData = exec6.results![0].json ?? exec6.results![0].text;
      expect(JSON.stringify(resultData)).toContain('success');

      // Variable persistence with await across executions
      await executeCode(
        ctx,
        'const persistedValue = await Promise.resolve(99);'
      );
      const exec7 = await executeCode(ctx, 'persistedValue');
      expect(exec7.results![0].text).toContain('99');

      // Promise auto-resolution without await keyword
      const exec8 = await executeCode(ctx, 'Promise.resolve(123)');
      expect(exec8.error).toBeUndefined();
      expect(exec8.results![0].text).toContain('123');

      // IIFE pattern for backward compatibility
      const exec9 = await executeCode(
        ctx,
        `(async () => {
  const value = await Promise.resolve('hello');
  return value + ' world';
})()`
      );
      expect(exec9.error).toBeUndefined();
      expect(exec9.results![0].text).toContain('hello world');

      // Error handling - reference error
      const exec10 = await executeCode(ctx, 'console.log(undefinedVariable);');
      expect(exec10.error).toBeDefined();
      expect(exec10.error!.name || exec10.error!.message).toMatch(
        /Error|undefined/i
      );

      // Cleanup
      await deleteContext(ctx.id);
    }, 120000);

    // ============================================================================
    // Test 4: Multi-language Workflow + Streaming
    // ============================================================================

    test('multi-language workflow: Python→JS data sharing + streaming', async () => {
      // Create Python context and generate data
      const pythonCtx = await createContext('python');
      const pythonExec = await executeCode(
        pythonCtx,
        `
import json
data = {'values': [1, 2, 3, 4, 5]}
with open('/tmp/shared_data.json', 'w') as f:
    json.dump(data, f)
print("Data saved")
`.trim()
      );
      expect(pythonExec.error).toBeUndefined();
      expect(pythonExec.logs.stdout.join('')).toContain('Data saved');

      // Create JavaScript context and consume data
      const jsCtx = await createContext('javascript');
      const jsExec = await executeCode(
        jsCtx,
        `
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/shared_data.json', 'utf8'));
const sum = data.values.reduce((a, b) => a + b, 0);
console.log('Sum:', sum);
`.trim()
      );
      expect(jsExec.error).toBeUndefined();
      expect(jsExec.logs.stdout.join('')).toContain('Sum: 15');

      // Test streaming execution
      const streamCtx = await createContext('python');
      const streamResponse = await fetch(
        `${workerUrl}/api/code/execute/stream`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            code: `
import time
for i in range(3):
    print(f"Step {i}")
    time.sleep(0.1)
`.trim(),
            options: { context: streamCtx }
          })
        }
      );

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toBe(
        'text/event-stream'
      );

      // Collect streaming events
      const reader = streamResponse.body?.getReader();
      expect(reader).toBeDefined();

      const decoder = new TextDecoder();
      const events: any[] = [];
      let buffer = '';

      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      // Parse SSE events
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Verify streaming output
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(0);
      const allOutput = stdoutEvents.map((e) => e.text).join('');
      expect(allOutput).toContain('Step 0');
      expect(allOutput).toContain('Step 1');
      expect(allOutput).toContain('Step 2');

      // Cleanup all contexts in parallel
      await Promise.all([
        deleteContext(pythonCtx.id),
        deleteContext(jsCtx.id),
        deleteContext(streamCtx.id)
      ]);
    }, 120000);

    // ============================================================================
    // Test 5: Context Isolation + Concurrency
    // ============================================================================

    test('context isolation and concurrency: isolation, many contexts, mutex', async () => {
      // Test basic isolation between two contexts
      const ctx1 = await createContext('python');
      const ctx2 = await createContext('python');

      await executeCode(ctx1, 'secret = "context1"');
      const isolationCheck = await executeCode(ctx2, 'print(secret)');
      expect(isolationCheck.error).toBeDefined();
      expect(
        isolationCheck.error!.name || isolationCheck.error!.message
      ).toMatch(/NameError|not defined/i);

      // Cleanup basic isolation contexts sequentially
      await deleteContext(ctx1.id);
      await deleteContext(ctx2.id);

      // Test isolation across 3 contexts
      const manyContexts: CodeContext[] = [];
      for (let i = 0; i < 3; i++) {
        manyContexts.push(await createContext('javascript'));
      }

      // Set unique values in each context
      for (let i = 0; i < manyContexts.length; i++) {
        const exec = await executeCode(
          manyContexts[i],
          `const contextValue = ${i}; contextValue;`
        );
        expect(exec.error, `Context ${i} set error`).toBeUndefined();
        expect(exec.results![0].text).toContain(String(i));
      }

      // Verify isolated state
      for (let i = 0; i < manyContexts.length; i++) {
        const exec = await executeCode(manyContexts[i], 'contextValue;');
        expect(exec.error, `Context ${i} read error`).toBeUndefined();
        expect(exec.results![0].text).toContain(String(i));
      }

      // Cleanup contexts sequentially
      for (const ctx of manyContexts) {
        await deleteContext(ctx.id);
      }

      // Test concurrent execution on same context (mutex test)
      const mutexCtx = await createContext('javascript');
      await executeCode(mutexCtx, 'let counter = 0;');

      // Launch 5 concurrent increments
      const concurrentRequests = 5;
      const results = await Promise.allSettled(
        Array.from({ length: concurrentRequests }, () =>
          executeCode(mutexCtx, 'counter++; counter;')
        )
      );

      // Collect counter values
      const counterValues: number[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const exec = result.value;
          expect(exec.error).toBeUndefined();
          const match = exec.results?.[0]?.text?.match(/\d+/);
          if (match) counterValues.push(parseInt(match[0], 10));
        }
      }

      // All 5 should succeed with values 1-5 (serial execution via mutex)
      expect(counterValues.length).toBe(concurrentRequests);
      counterValues.sort((a, b) => a - b);
      expect(counterValues).toEqual(Array.from({ length: 5 }, (_, i) => i + 1));

      // Verify final counter state
      const finalExec = await executeCode(mutexCtx, 'counter;');
      const finalValue = parseInt(
        finalExec.results?.[0]?.text?.match(/\d+/)?.[0] || '0',
        10
      );
      expect(finalValue).toBe(5);

      await deleteContext(mutexCtx.id);
    }, 30000);

    // ============================================================================
    // Test 6: Error Handling
    // ============================================================================

    test('error handling: invalid language, non-existent context, Python unavailable', async () => {
      // Invalid language
      const invalidLangResponse = await fetch(
        `${workerUrl}/api/code/context/create`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ language: 'invalid-lang' })
        }
      );
      expect(invalidLangResponse.status).toBeGreaterThanOrEqual(400);
      const invalidLangError =
        (await invalidLangResponse.json()) as ErrorResponse;
      expect(invalidLangError.error).toBeTruthy();

      // Non-existent context execution
      const fakeContextExec = await fetch(`${workerUrl}/api/code/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          code: 'print("test")',
          options: {
            context: { id: 'fake-context-id-12345', language: 'python' }
          }
        })
      });
      expect(fakeContextExec.status).toBeGreaterThanOrEqual(400);
      const fakeContextError = (await fakeContextExec.json()) as ErrorResponse;
      expect(fakeContextError.error).toBeTruthy();

      // Delete non-existent context
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: 'echo "init"' })
      });
      const deleteFakeResponse = await fetch(
        `${workerUrl}/api/code/context/fake-id-99999`,
        { method: 'DELETE', headers }
      );
      expect(deleteFakeResponse.status).toBeGreaterThanOrEqual(400);
      const deleteFakeError =
        (await deleteFakeResponse.json()) as ErrorResponse;
      expect(deleteFakeError.error).toBeTruthy();

      // Python unavailable on base image
      const sandbox = await getSharedSandbox();
      const baseImageHeaders = sandbox.createHeaders(createUniqueSession());
      const pythonUnavailableResponse = await fetch(
        `${workerUrl}/api/code/context/create`,
        {
          method: 'POST',
          headers: baseImageHeaders,
          body: JSON.stringify({ language: 'python' })
        }
      );
      expect(pythonUnavailableResponse.status).toBe(500);
      const pythonUnavailableError =
        (await pythonUnavailableResponse.json()) as ErrorResponse;
      expect(pythonUnavailableError.error).toContain(
        'Python interpreter not available'
      );
      expect(pythonUnavailableError.error).toMatch(/-python/);
    }, 30000);
  }
);
