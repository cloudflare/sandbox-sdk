import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { getTestWorkerUrl, WranglerDevRunner } from './helpers/wrangler-runner';
import { createSandboxId, createTestHeaders, fetchWithStartup, cleanupSandbox } from './helpers/test-fixtures';
import { parseSSEStream } from '../../packages/sandbox/src/sse-parser';
import type { ExecEvent } from '@repo/shared';

/**
 * Streaming Operations Workflow Integration Tests
 *
 * Tests the README "AsyncIterable Streaming Support" (lines 636-709):
 * - Real-time output streaming via execStream()
 * - Event types: start, stdout, stderr, complete, error
 * - State persistence after streaming commands
 * - Error handling during streaming
 * - Concurrent streaming operations
 *
 * This validates the execStream() method which provides SSE-based
 * streaming for real-time command output.
 */
describe('Streaming Operations Workflow', () => {
  describe('local', () => {
    let runner: WranglerDevRunner | null;
    let workerUrl: string;
    let currentSandboxId: string | null = null;

    beforeAll(async () => {
      // Get test worker URL (CI: uses deployed URL, Local: spawns wrangler dev)
      const result = await getTestWorkerUrl();
      workerUrl = result.url;
      runner = result.runner;
    });

    afterEach(async () => {
      // Cleanup sandbox container after each test
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

    /**
     * Helper to collect events from streaming response using SDK's parseSSEStream utility
     */
    async function collectSSEEvents(response: Response, maxEvents: number = 50): Promise<ExecEvent[]> {
      if (!response.body) {
        throw new Error('No readable stream in response');
      }

      console.log('[Test] Starting to consume stream...');
      const events: ExecEvent[] = [];
      const abortController = new AbortController();

      try {
        for await (const event of parseSSEStream<ExecEvent>(response.body, abortController.signal)) {
          console.log('[Test] Received event:', event.type);
          events.push(event);

          // Stop after complete or error event
          if (event.type === 'complete' || event.type === 'error') {
            abortController.abort();
            break;
          }

          // Stop if we've collected enough events
          if (events.length >= maxEvents) {
            abortController.abort();
            break;
          }
        }
      } catch (error) {
        // Ignore abort errors (expected when we stop early)
        if (error instanceof Error && error.message !== 'Operation was aborted') {
          throw error;
        }
      }

      console.log('[Test] Collected', events.length, 'events total');
      return events;
    }

    test('should stream stdout events in real-time', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Stream a command that outputs multiple lines
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'echo "Line 1"; echo "Line 2"; echo "Line 3"',
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toBe('text/event-stream');

      // Collect events from stream
      const events = await collectSSEEvents(streamResponse);

      // Verify we got events
      expect(events.length).toBeGreaterThan(0);

      // Should have start event
      const startEvent = events.find((e) => e.type === 'start');
      expect(startEvent).toBeDefined();
      expect(startEvent?.command).toContain('echo');

      // Should have stdout events
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(0);

      // Combine stdout data
      const output = stdoutEvents.map((e) => e.data).join('');
      expect(output).toContain('Line 1');
      expect(output).toContain('Line 2');
      expect(output).toContain('Line 3');

      // Should have complete event
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(0);
    }, 90000);

    test('should stream stderr events separately', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Stream a command that outputs to both stdout and stderr (wrap in bash -c for >&2)
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: "bash -c 'echo stdout message; echo stderr message >&2'",
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(streamResponse.status).toBe(200);

      const events = await collectSSEEvents(streamResponse);

      // Should have both stdout and stderr events
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const stderrEvents = events.filter((e) => e.type === 'stderr');

      expect(stdoutEvents.length).toBeGreaterThan(0);
      expect(stderrEvents.length).toBeGreaterThan(0);

      // Verify data
      const stdoutData = stdoutEvents.map((e) => e.data).join('');
      const stderrData = stderrEvents.map((e) => e.data).join('');

      expect(stdoutData).toContain('stdout message');
      expect(stderrData).toContain('stderr message');

      // Verify stdout doesn't contain stderr and vice versa
      expect(stdoutData).not.toContain('stderr message');
      expect(stderrData).not.toContain('stdout message');
    }, 90000);

    test('should include all event types: start, stdout, complete', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'echo "Hello Streaming"',
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      const events = await collectSSEEvents(streamResponse);

      // Verify event types
      const eventTypes = new Set(events.map((e) => e.type));

      expect(eventTypes.has('start')).toBe(true);
      expect(eventTypes.has('stdout')).toBe(true);
      expect(eventTypes.has('complete')).toBe(true);

      // Verify event order: start should be first, complete should be last
      expect(events[0].type).toBe('start');
      expect(events[events.length - 1].type).toBe('complete');

      // Verify all events have timestamps
      for (const event of events) {
        expect(event.timestamp).toBeDefined();
        expect(typeof event.timestamp).toBe('string');
      }
    }, 90000);

    test('should handle command failures with non-zero exit code', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Stream a command that fails
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'false', // Always fails with exit code 1
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      const events = await collectSSEEvents(streamResponse);

      // Should have complete event with non-zero exit code
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).not.toBe(0);
    }, 90000);

    test('should handle nonexistent commands with proper exit code', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Initialize sandbox first
      await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'echo "init"',
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      // Try to stream a nonexistent command (should execute and fail with exit code 127)
      const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'nonexistentcommand123',
        }),
      });

      // Should return 200 (streaming started successfully)
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toBe('text/event-stream');

      // Collect events from stream
      const events = await collectSSEEvents(streamResponse);

      // Should have complete event with exit code 127 (command not found)
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(127); // Standard Unix "command not found" exit code

      // Should have stderr events with error message
      const stderrEvents = events.filter((e) => e.type === 'stderr');
      expect(stderrEvents.length).toBeGreaterThan(0);

      // Verify stderr contains command not found message
      const stderrData = stderrEvents.map((e) => e.data).join('');
      expect(stderrData.toLowerCase()).toMatch(/command not found|not found/);
    }, 90000);

    test('should handle environment variables in streaming commands', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Stream a command that sets and uses a variable within the same bash invocation
      const streamResponse1 = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: "bash -c 'STREAM_VAR=streaming-value; echo $STREAM_VAR'",
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      const events1 = await collectSSEEvents(streamResponse1);
      const completeEvent1 = events1.find((e) => e.type === 'complete');
      expect(completeEvent1?.exitCode).toBe(0);

      // Verify the output shows the variable value
      const stdoutEvents1 = events1.filter((e) => e.type === 'stdout');
      const output1 = stdoutEvents1.map((e) => e.data).join('');
      expect(output1).toContain('streaming-value');
    }, 90000);

    test('should handle long-running streaming commands', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Stream a command that outputs over time (wrap in bash -c for loop)
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: "bash -c 'for i in 1 2 3 4 5; do echo \"Count: $i\"; sleep 0.2; done'",
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      const events = await collectSSEEvents(streamResponse, 20);

      // Should receive multiple stdout events over time
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThanOrEqual(5);

      // Verify we got all counts
      const output = stdoutEvents.map((e) => e.data).join('');
      for (let i = 1; i <= 5; i++) {
        expect(output).toContain(`Count: ${i}`);
      }

      // Should complete successfully
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(0);
    }, 90000);

    test('should support concurrent streaming operations', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Initialize with first request
      await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'echo "init"',
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      // Start two streaming commands concurrently
      const stream1Promise = fetch(`${workerUrl}/api/execStream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "Stream 1"; sleep 1; echo "Stream 1 done"',
        }),
      });

      const stream2Promise = fetch(`${workerUrl}/api/execStream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: 'echo "Stream 2"; sleep 1; echo "Stream 2 done"',
        }),
      });

      // Wait for both streams to start
      const [stream1Response, stream2Response] = await Promise.all([stream1Promise, stream2Promise]);

      expect(stream1Response.status).toBe(200);
      expect(stream2Response.status).toBe(200);

      // Collect events from both streams
      const [events1, events2] = await Promise.all([
        collectSSEEvents(stream1Response),
        collectSSEEvents(stream2Response),
      ]);

      // Verify both completed successfully
      const complete1 = events1.find((e) => e.type === 'complete');
      const complete2 = events2.find((e) => e.type === 'complete');

      expect(complete1).toBeDefined();
      expect(complete1?.exitCode).toBe(0);
      expect(complete2).toBeDefined();
      expect(complete2?.exitCode).toBe(0);

      // Verify outputs didn't mix
      const output1 = events1.filter((e) => e.type === 'stdout').map((e) => e.data).join('');
      const output2 = events2.filter((e) => e.type === 'stdout').map((e) => e.data).join('');

      expect(output1).toContain('Stream 1');
      expect(output1).not.toContain('Stream 2');
      expect(output2).toContain('Stream 2');
      expect(output2).not.toContain('Stream 1');
    }, 90000);

    test('should work with explicit sessions', async () => {
      currentSandboxId = createSandboxId();

      // Create a session with environment variables
      const sessionResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/session/create`, {
          method: 'POST',
          headers: createTestHeaders(currentSandboxId ?? ''),
          body: JSON.stringify({
            env: {
              SESSION_ID: 'test-session-streaming',
              NODE_ENV: 'test',
            },
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      const sessionData = await sessionResponse.json();
      const sessionId = sessionData.sessionId;
      if (!sessionId) {
        throw new Error('Session ID not returned from API');
      }

      // Stream a command in the session
      const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
        method: 'POST',
        headers: createTestHeaders(currentSandboxId, sessionId),
        body: JSON.stringify({
          command: 'echo "Session: $SESSION_ID, Env: $NODE_ENV"',
        }),
      });

      const events = await collectSSEEvents(streamResponse);

      // Verify output contains session environment variables
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const output = stdoutEvents.map((e) => e.data).join('');

      expect(output).toContain('Session: test-session-streaming');
      expect(output).toContain('Env: test');

      // Verify complete
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent?.exitCode).toBe(0);
    }, 90000);


    test('should keep container alive during 15+ second streaming command (GitHub #101)', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      console.log('[Test] Starting 15+ second streaming command to verify activity renewal...');

      // Stream a command that runs for 15+ seconds with output every 2 seconds
      // Without activity renewal, this would timeout (default container timeout is ~10s)
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: "bash -c 'for i in {1..8}; do echo \"Tick $i at $(date +%s)\"; sleep 2; done; echo \"SUCCESS\"'",
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(streamResponse.status).toBe(200);

      const startTime = Date.now();
      const events = await collectSSEEvents(streamResponse, 50);
      const duration = Date.now() - startTime;

      console.log(`[Test] Stream completed in ${duration}ms`);

      // Verify command ran for approximately 16 seconds (8 ticks * 2 seconds)
      expect(duration).toBeGreaterThan(14000); // At least 14 seconds
      expect(duration).toBeLessThan(25000); // But completed (not timed out)

      // Should have received all ticks
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const output = stdoutEvents.map((e) => e.data).join('');

      for (let i = 1; i <= 8; i++) {
        expect(output).toContain(`Tick ${i}`);
      }
      expect(output).toContain('SUCCESS');

      // Most importantly: should complete with exit code 0 (not timeout)
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(0);

      console.log('[Test] ✅ Container stayed alive for 16+ seconds - activity renewal working!');
    }, 90000);

    test('should handle high-volume streaming over extended period', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      console.log('[Test] Starting high-volume streaming test...');

      // Stream command that generates many lines over 10+ seconds
      // Tests throttling: renewActivityTimeout shouldn't be called for every chunk
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: "bash -c 'for i in {1..100}; do echo \"Line $i: $(date +%s.%N)\"; sleep 0.1; done'",
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(streamResponse.status).toBe(200);

      const events = await collectSSEEvents(streamResponse, 150);

      // Should have many stdout events
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThanOrEqual(50);

      // Verify we got output from beginning and end
      const output = stdoutEvents.map((e) => e.data).join('');
      expect(output).toContain('Line 1');
      expect(output).toContain('Line 100');

      // Should complete successfully
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(0);

      console.log('[Test] ✅ High-volume streaming completed successfully');
    }, 90000);

    test('should handle streaming with intermittent output gaps', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      console.log('[Test] Starting intermittent output test...');

      // Command with gaps between output bursts
      // Tests that activity renewal works even when output is periodic
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: "bash -c 'echo \"Burst 1\"; sleep 3; echo \"Burst 2\"; sleep 3; echo \"Burst 3\"; sleep 3; echo \"Complete\"'",
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(streamResponse.status).toBe(200);

      const events = await collectSSEEvents(streamResponse, 30);

      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const output = stdoutEvents.map((e) => e.data).join('');

      // All bursts should be received despite gaps
      expect(output).toContain('Burst 1');
      expect(output).toContain('Burst 2');
      expect(output).toContain('Burst 3');
      expect(output).toContain('Complete');

      // Should complete successfully
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(0);

      console.log('[Test] ✅ Intermittent output handled correctly');
    }, 90000);

    /**
     * Test for callback-based streaming 
     * This validates that long-running commands work via callback pattern
     */
    test('should handle very long-running commands (60+ seconds) via callback-based streaming', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      console.log('[Test] Starting 60+ second command via callback-based streaming...');

      // With callback-based streaming, it should complete successfully
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStreamCallback`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            // Command that runs for 60+ seconds with periodic output
            command: "bash -c 'for i in {1..12}; do echo \"Minute mark $i\"; sleep 5; done; echo \"COMPLETED\"'",
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(streamResponse.status).toBe(200);

      const startTime = Date.now();
      const events = await collectSSEEvents(streamResponse, 100);
      const duration = Date.now() - startTime;

      console.log(`[Test] Very long stream completed in ${duration}ms`);

      // Verify command ran for approximately 60 seconds (12 ticks * 5 seconds)
      expect(duration).toBeGreaterThan(55000); // At least 55 seconds
      expect(duration).toBeLessThan(75000); // But not timed out (under 75s)

      // Should have received all minute marks
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const output = stdoutEvents.map((e) => e.data).join('');

      for (let i = 1; i <= 12; i++) {
        expect(output).toContain(`Minute mark ${i}`);
      }
      expect(output).toContain('COMPLETED');

      // Most importantly: should complete with exit code 0 (not timeout/disconnect)
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(0);

      console.log('[Test] ✅ Very long-running command completed!');
    }, 90000);

    test('should handle command that sleeps for extended period', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      console.log('[Test] Testing sleep 45 && echo "done" pattern...');

      // This is the exact pattern that was failing before
      const streamResponse = await vi.waitFor(
        async () => fetchWithStartup(`${workerUrl}/api/execStreamCallback`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: 'sleep 45 && echo "done"',
          }),
        }),
        { timeout: 90000, interval: 2000 }
      );

      expect(streamResponse.status).toBe(200);

      const startTime = Date.now();
      const events = await collectSSEEvents(streamResponse, 20);
      const duration = Date.now() - startTime;

      console.log(`[Test] Sleep command completed in ${duration}ms`);

      // Should have taken at least 45 seconds
      expect(duration).toBeGreaterThan(44000);

      // Should have the output
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      const output = stdoutEvents.map((e) => e.data).join('');
      expect(output).toContain('done');

      // Should complete successfully
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.exitCode).toBe(0);

      console.log('[Test] ✅ Long sleep command completed without disconnect!');
    }, 90000);
  });
});
