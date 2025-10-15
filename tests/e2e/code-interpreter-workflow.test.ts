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
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, fetchWithStartup, cleanupSandbox } from './helpers/test-fixtures';

describe('Code Interpreter Workflow (E2E)', () => {
  let runner: WranglerDevRunner | null;
  let workerUrl: string;
  let currentSandboxId: string | null = null;

  beforeAll(async () => {
    const result = await getTestWorkerUrl();
    workerUrl = result.url;
    runner = result.runner;
  }, 120000);

  afterEach(async () => {
    if (currentSandboxId) {
      await cleanupSandbox(workerUrl, currentSandboxId);
      currentSandboxId = null;
    }
  });

  afterAll(async () => {
    if (runner) {
      await runner.stop();
    }
  });

  // ============================================================================
  // Context Management
  // ============================================================================

  test('should create and list code contexts', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create Python context
    const pythonCtxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    expect(pythonCtxResponse.status).toBe(200);
    const pythonCtx = await pythonCtxResponse.json();
    expect(pythonCtx.id).toBeTruthy();
    expect(pythonCtx.language).toBe('python');

    // Create JavaScript context
    const jsCtxResponse = await fetch(`${workerUrl}/api/code/context/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ language: 'javascript' }),
    });

    expect(jsCtxResponse.status).toBe(200);
    const jsCtx = await jsCtxResponse.json();
    expect(jsCtx.id).toBeTruthy();
    expect(jsCtx.language).toBe('javascript');
    expect(jsCtx.id).not.toBe(pythonCtx.id); // Different contexts

    // List all contexts
    const listResponse = await fetch(`${workerUrl}/api/code/context/list`, {
      method: 'GET',
      headers,
    });

    expect(listResponse.status).toBe(200);
    const contexts = await listResponse.json();
    expect(Array.isArray(contexts)).toBe(true);
    expect(contexts.length).toBeGreaterThanOrEqual(2);

    const contextIds = contexts.map((ctx: any) => ctx.id);
    expect(contextIds).toContain(pythonCtx.id);
    expect(contextIds).toContain(jsCtx.id);
  }, 120000);

  test('should delete code context', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create context
    const createResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await createResponse.json();
    const contextId = context.id;

    // Delete context
    const deleteResponse = await fetch(`${workerUrl}/api/code/context/${contextId}`, {
      method: 'DELETE',
      headers,
    });

    expect(deleteResponse.status).toBe(200);
    const deleteData = await deleteResponse.json();
    expect(deleteData.success).toBe(true);
    expect(deleteData.contextId).toBe(contextId);

    // Verify context is removed from list
    const listResponse = await fetch(`${workerUrl}/api/code/context/list`, {
      method: 'GET',
      headers,
    });

    const contexts = await listResponse.json();
    const contextIds = contexts.map((ctx: any) => ctx.id);
    expect(contextIds).not.toContain(contextId);
  }, 120000);

  // ============================================================================
  // Python Code Execution
  // ============================================================================

  test('should execute simple Python code', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create Python context
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await ctxResponse.json();

    // Execute Python code
    const execResponse = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'print("Hello from Python!")',
        options: { context },
      }),
    });

    expect(execResponse.status).toBe(200);
    const execution = await execResponse.json();

    expect(execution.code).toBe('print("Hello from Python!")');
    expect(execution.logs.stdout.join('')).toContain('Hello from Python!');
    expect(execution.error).toBeUndefined();
  }, 120000);

  test('should maintain Python state across executions', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create context
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await ctxResponse.json();

    // Set variable in first execution
    const exec1Response = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'x = 42\ny = 10',
        options: { context },
      }),
    });

    expect(exec1Response.status).toBe(200);
    const execution1 = await exec1Response.json();
    expect(execution1.error).toBeUndefined();

    // Use variable in second execution
    const exec2Response = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'result = x + y\nprint(result)',
        options: { context },
      }),
    });

    expect(exec2Response.status).toBe(200);
    const execution2 = await exec2Response.json();
    expect(execution2.logs.stdout.join('')).toContain('52');
    expect(execution2.error).toBeUndefined();
  }, 120000);

  test('should handle Python errors gracefully', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create context
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await ctxResponse.json();

    // Execute code with division by zero error
    const execResponse = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'x = 1 / 0',
        options: { context },
      }),
    });

    expect(execResponse.status).toBe(200);
    const execution = await execResponse.json();

    expect(execution.error).toBeDefined();
    expect(execution.error.name).toContain('Error');
    expect(execution.error.message || execution.error.traceback).toContain('division');
  }, 120000);

  // ============================================================================
  // JavaScript Code Execution
  // ============================================================================

  test('should execute simple JavaScript code', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create JavaScript context
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'javascript' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await ctxResponse.json();

    // Execute JavaScript code
    const execResponse = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'console.log("Hello from JavaScript!");',
        options: { context },
      }),
    });

    expect(execResponse.status).toBe(200);
    const execution = await execResponse.json();

    expect(execution.logs.stdout.join('')).toContain('Hello from JavaScript!');
    expect(execution.error).toBeUndefined();
  }, 120000);

  test('should maintain JavaScript state across executions', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create context
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'javascript' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await ctxResponse.json();

    // Set global variable
    const exec1Response = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'global.counter = 0;',
        options: { context },
      }),
    });

    expect(exec1Response.status).toBe(200);

    // Increment and read variable
    const exec2Response = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'console.log(++global.counter);',
        options: { context },
      }),
    });

    expect(exec2Response.status).toBe(200);
    const execution2 = await exec2Response.json();
    expect(execution2.logs.stdout.join('')).toContain('1');
  }, 120000);

  test('should handle JavaScript errors gracefully', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create context
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'javascript' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await ctxResponse.json();

    // Execute code with reference error
    const execResponse = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'console.log(undefinedVariable);',
        options: { context },
      }),
    });

    expect(execResponse.status).toBe(200);
    const execution = await execResponse.json();

    expect(execution.error).toBeDefined();
    expect(execution.error.name || execution.error.message).toMatch(/Error|undefined/i);
  }, 120000);

  // ============================================================================
  // Streaming Execution
  // ============================================================================

  test('should stream Python execution output', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create context
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context = await ctxResponse.json();

    // Execute code with streaming
    const streamResponse = await fetch(`${workerUrl}/api/code/execute/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: `
import time
for i in range(3):
    print(f"Step {i}")
    time.sleep(0.1)
`.trim(),
        options: { context },
      }),
    });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toBe('text/event-stream');

    // Collect streaming events
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    if (!reader) return;

    const decoder = new TextDecoder();
    const events: any[] = [];
    let buffer = '';

    // Read entire stream
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
    }

    // Parse SSE events
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6));
          events.push(event);
        } catch (e) {
          // Ignore parse errors
        }
      }
    }

    // Verify we received output events
    expect(events.length).toBeGreaterThan(0);

    // Check for stdout events
    const stdoutEvents = events.filter((e) => e.type === 'stdout');
    expect(stdoutEvents.length).toBeGreaterThan(0);

    // Verify output content
    const allOutput = stdoutEvents.map((e) => e.data).join('');
    expect(allOutput).toContain('Step 0');
    expect(allOutput).toContain('Step 1');
    expect(allOutput).toContain('Step 2');
  }, 120000);

  // ============================================================================
  // Multi-Language Workflow
  // ============================================================================

  test('should process data in Python and consume in JavaScript', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create Python context
    const pythonCtxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const pythonCtx = await pythonCtxResponse.json();

    // Generate data in Python and save to file
    const pythonExecResponse = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: `
import json
data = {'values': [1, 2, 3, 4, 5]}
with open('/tmp/shared_data.json', 'w') as f:
    json.dump(data, f)
print("Data saved")
`.trim(),
        options: { context: pythonCtx },
      }),
    });

    expect(pythonExecResponse.status).toBe(200);
    const pythonExec = await pythonExecResponse.json();
    expect(pythonExec.error).toBeUndefined();
    expect(pythonExec.logs.stdout.join('')).toContain('Data saved');

    // Create JavaScript context
    const jsCtxResponse = await fetch(`${workerUrl}/api/code/context/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ language: 'javascript' }),
    });

    const jsCtx = await jsCtxResponse.json();

    // Read and process data in JavaScript
    const jsExecResponse = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: `
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/shared_data.json', 'utf8'));
const sum = data.values.reduce((a, b) => a + b, 0);
console.log('Sum:', sum);
`.trim(),
        options: { context: jsCtx },
      }),
    });

    expect(jsExecResponse.status).toBe(200);
    const jsExec = await jsExecResponse.json();
    expect(jsExec.error).toBeUndefined();
    expect(jsExec.logs.stdout.join('')).toContain('Sum: 15');
  }, 120000);

  // ============================================================================
  // Context Isolation
  // ============================================================================

  test('should isolate variables between contexts', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Create two Python contexts
    const ctx1Response = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'python' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    const context1 = await ctx1Response.json();

    const ctx2Response = await fetch(`${workerUrl}/api/code/context/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ language: 'python' }),
    });

    const context2 = await ctx2Response.json();

    // Set variable in context 1
    const exec1Response = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'secret = "context1"',
        options: { context: context1 },
      }),
    });

    expect(exec1Response.status).toBe(200);

    // Try to access variable in context 2 - should fail
    const exec2Response = await fetch(`${workerUrl}/api/code/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: 'print(secret)',
        options: { context: context2 },
      }),
    });

    expect(exec2Response.status).toBe(200);
    const execution2 = await exec2Response.json();

    // Should have error about undefined variable
    expect(execution2.error).toBeDefined();
    expect(execution2.error.name || execution2.error.message).toMatch(/NameError|not defined/i);
  }, 120000);

  // ============================================================================
  // Error Handling
  // ============================================================================

  test('should return error for invalid language', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Try to create context with invalid language
    const ctxResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/context/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language: 'invalid-lang' }),
      }, { expectSuccess: false }),
      { timeout: 90000, interval: 2000 }
    );

    // Should return error
    expect(ctxResponse.status).toBeGreaterThanOrEqual(400);
    const errorData = await ctxResponse.json();
    expect(errorData.error || errorData.message).toBeTruthy();
  }, 120000);

  test('should return error for non-existent context', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Try to execute with fake context
    const execResponse = await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/code/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          code: 'print("test")',
          options: { context: { id: 'fake-context-id-12345', language: 'python' } },
        }),
      }, { expectSuccess: false }),
      { timeout: 90000, interval: 2000 }
    );

    // Should return error
    expect(execResponse.status).toBeGreaterThanOrEqual(400);
    const errorData = await execResponse.json();
    expect(errorData.error || errorData.message).toBeTruthy();
  }, 120000);

  test('should return error when deleting non-existent context', async () => {
    currentSandboxId = createSandboxId();
    const headers = createTestHeaders(currentSandboxId);

    // Initialize sandbox
    await vi.waitFor(
      async () => fetchWithStartup(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: 'echo "init"' }),
      }),
      { timeout: 90000, interval: 2000 }
    );

    // Try to delete non-existent context
    const deleteResponse = await fetch(`${workerUrl}/api/code/context/fake-id-99999`, {
      method: 'DELETE',
      headers,
    });

    // Should return error
    expect(deleteResponse.status).toBeGreaterThanOrEqual(400);
    const errorData = await deleteResponse.json();
    expect(errorData.error || errorData.message).toBeTruthy();
  }, 120000);
});
