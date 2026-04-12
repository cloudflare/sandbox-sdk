/**
 * Stream Controller Race Condition Tests
 *
 * Reproduces GitHub issue #13442: "startProcess stream controller closes prematurely"
 *
 * The bug occurs when:
 * 1. Client connects to process stream endpoint
 * 2. Client disconnects (cancels stream) while process is still outputting
 * 3. Process triggers output/status callbacks after cancellation
 * 4. Callbacks try to use closed controller -> TypeError
 *
 * This causes "Invalid state: Controller is already closed" errors that
 * can poison the SDK bridge, making subsequent operations fail.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

describe('Stream Controller Race Condition', () => {
  let sandbox: TestSandbox;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers(createUniqueSession());
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
  }, 120000);

  /**
   * Test 1: Basic stream cancellation race
   *
   * This reproduces the core issue: client disconnects while
   * process is still producing output. The race condition occurs
   * when the output listener fires after stream cancellation.
   */
  test('should handle stream cancellation without controller errors', async () => {
    // Start a process that outputs continuously for several seconds
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command:
          'bash -c "for i in {1..100}; do echo line $i; sleep 0.01; done"'
      })
    });

    expect(startResponse.status).toBe(200);
    const processData = (await startResponse.json()) as { id: string };

    // Connect to the stream endpoint
    const streamResponse = await fetch(
      `${workerUrl}/api/process/${processData.id}/stream`,
      {
        method: 'GET',
        headers
      }
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.body).toBeDefined();

    const reader = streamResponse.body!.getReader();

    // Read initial process_info event to ensure listeners are registered
    const { value } = await reader.read();
    expect(value).toBeDefined();

    // Immediately cancel the stream (simulates client disconnect)
    await reader.cancel();

    // Give time for the race condition to potentially trigger
    // The bug occurs when callbacks queued before cancel fire after
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Container should still be healthy - this is the key assertion
    // If the controller error poisoned the bridge, this will fail
    const healthCheck = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo healthy' })
    });

    expect(healthCheck.status).toBe(200);
    const healthResult = (await healthCheck.json()) as { stdout: string };
    expect(healthResult.stdout).toContain('healthy');

    // Cleanup the process
    await fetch(`${workerUrl}/api/process/${processData.id}`, {
      method: 'DELETE',
      headers
    });
  }, 30000);

  /**
   * Test 2: Multiple rapid stream connects/disconnects
   *
   * Increases likelihood of hitting the race condition by
   * creating multiple opportunities for the callback/cancel race.
   */
  test('should handle multiple rapid stream connects and disconnects', async () => {
    // Start a long-running process that continuously outputs
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'bash -c "while true; do echo $(date +%s%N); sleep 0.05; done"'
      })
    });

    expect(startResponse.status).toBe(200);
    const processData = (await startResponse.json()) as { id: string };

    // Perform multiple rapid connect/disconnect cycles
    for (let i = 0; i < 5; i++) {
      const streamResponse = await fetch(
        `${workerUrl}/api/process/${processData.id}/stream`,
        {
          method: 'GET',
          headers
        }
      );

      if (streamResponse.status === 200 && streamResponse.body) {
        const reader = streamResponse.body.getReader();

        // Read one chunk
        try {
          await reader.read();
        } catch {
          // Ignore read errors
        }

        // Immediately cancel
        await reader.cancel().catch(() => {});
      }

      // Small delay between cycles
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Cleanup the process
    await fetch(`${workerUrl}/api/process/${processData.id}`, {
      method: 'DELETE',
      headers
    });

    // Verify container is still healthy
    const healthCheck = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo post-rapid-check' })
    });

    expect(healthCheck.status).toBe(200);
  }, 30000);

  /**
   * Test 3: Stream cancellation during process completion
   *
   * The race condition can also occur when the process completes
   * (triggering status listener) at the same time the stream is cancelled.
   */
  test('should handle stream cancellation during process completion', async () => {
    // Start a fast-completing process
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'bash -c "echo start; sleep 0.1; echo done"'
      })
    });

    expect(startResponse.status).toBe(200);
    const processData = (await startResponse.json()) as { id: string };

    // Connect to stream immediately
    const streamResponse = await fetch(
      `${workerUrl}/api/process/${processData.id}/stream`,
      {
        method: 'GET',
        headers
      }
    );

    if (streamResponse.status === 200 && streamResponse.body) {
      const reader = streamResponse.body.getReader();

      // Read a chunk (might be initial buffered output)
      await reader.read().catch(() => {});

      // Cancel before waiting for completion
      // This creates race: status callback vs cancel cleanup
      await reader.cancel().catch(() => {});
    }

    // Wait for process to actually complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify container health
    const healthCheck = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo completion-check' })
    });

    expect(healthCheck.status).toBe(200);
  }, 30000);

  /**
   * Test 4: Concurrent streams to same process
   *
   * Multiple clients connecting to the same process stream
   * increases complexity and chance of race conditions.
   */
  test('should handle concurrent streams to same process', async () => {
    // Start a process with output
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command:
          'bash -c "for i in {1..50}; do echo batch-$i; sleep 0.02; done"'
      })
    });

    expect(startResponse.status).toBe(200);
    const processData = (await startResponse.json()) as { id: string };

    // Start multiple concurrent streams
    const streams: Promise<void>[] = [];

    for (let i = 0; i < 3; i++) {
      streams.push(
        (async () => {
          const streamResponse = await fetch(
            `${workerUrl}/api/process/${processData.id}/stream`,
            {
              method: 'GET',
              headers
            }
          );

          if (streamResponse.status === 200 && streamResponse.body) {
            const reader = streamResponse.body.getReader();

            // Read a few chunks
            for (let j = 0; j < 3; j++) {
              try {
                const { done } = await reader.read();
                if (done) break;
              } catch {
                break;
              }
            }

            // Cancel with varying timing
            await new Promise((resolve) => setTimeout(resolve, i * 20));
            await reader.cancel().catch(() => {});
          }
        })()
      );
    }

    await Promise.all(streams);

    // Cleanup
    await fetch(`${workerUrl}/api/process/${processData.id}`, {
      method: 'DELETE',
      headers
    });

    // Health check
    const healthCheck = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo concurrent-check' })
    });

    expect(healthCheck.status).toBe(200);
  }, 30000);

  /**
   * Test 5: Execute streaming endpoint race condition
   *
   * The execute/stream endpoint has similar vulnerability
   * since it uses the same streaming pattern.
   */
  test('should handle execute/stream cancellation gracefully', async () => {
    // Start streaming execution
    const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'bash -c "for i in {1..50}; do echo exec-$i; sleep 0.01; done"'
      })
    });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.body).toBeDefined();

    const reader = streamResponse.body!.getReader();

    // Read initial chunk
    await reader.read();

    // Cancel early
    await reader.cancel();

    // Wait for potential race
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Health check
    const healthCheck = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo exec-stream-check' })
    });

    expect(healthCheck.status).toBe(200);
  }, 30000);
});
