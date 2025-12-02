import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';
import { parseSSEStream } from '../../packages/sandbox/src/sse-parser';
import type { ExecEvent } from '@repo/shared';

/**
 * Streaming Operations Edge Case Tests
 *
 * Tests error handling and long-running edge cases for streaming.
 * Basic streaming tests are in comprehensive-workflow.test.ts.
 *
 * This file focuses on:
 * - Command failures with non-zero exit codes
 * - Nonexistent commands (exit code 127)
 * - Long-running commands (15s+, 60s+)
 * - High-volume streaming
 * - Intermittent output gaps
 */
describe('Streaming Operations Edge Cases', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  async function collectSSEEvents(
    response: Response,
    maxEvents: number = 50
  ): Promise<ExecEvent[]> {
    if (!response.body) {
      throw new Error('No readable stream in response');
    }

    const events: ExecEvent[] = [];
    const abortController = new AbortController();

    try {
      for await (const event of parseSSEStream<ExecEvent>(
        response.body,
        abortController.signal
      )) {
        events.push(event);
        if (event.type === 'complete' || event.type === 'error') {
          abortController.abort();
          break;
        }
        if (events.length >= maxEvents) {
          abortController.abort();
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message !== 'Operation was aborted') {
        throw error;
      }
    }

    return events;
  }

  test('should handle command failures with non-zero exit code', async () => {
    const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'false' // Always fails with exit code 1
      })
    });

    const events = await collectSSEEvents(streamResponse);

    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.exitCode).not.toBe(0);
  }, 90000);

  test('should handle nonexistent commands with proper exit code', async () => {
    const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'nonexistentcommand123'
      })
    });

    expect(streamResponse.status).toBe(200);

    const events = await collectSSEEvents(streamResponse);

    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.exitCode).toBe(127); // Command not found

    const stderrEvents = events.filter((e) => e.type === 'stderr');
    expect(stderrEvents.length).toBeGreaterThan(0);
    const stderrData = stderrEvents.map((e) => e.data).join('');
    expect(stderrData.toLowerCase()).toMatch(/command not found|not found/);
  }, 90000);

  test('should handle streaming with multiple output chunks over time', async () => {
    // Tests that streaming correctly delivers output over ~2 seconds
    const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command:
          'bash -c \'for i in 1 2 3; do echo "Chunk $i"; sleep 0.5; done; echo "DONE"\''
      })
    });

    expect(streamResponse.status).toBe(200);

    const startTime = Date.now();
    const events = await collectSSEEvents(streamResponse, 20);
    const duration = Date.now() - startTime;

    // Should take ~1.5s (3 × 0.5s sleeps)
    expect(duration).toBeGreaterThan(1000);
    expect(duration).toBeLessThan(10000);

    const stdoutEvents = events.filter((e) => e.type === 'stdout');
    const output = stdoutEvents.map((e) => e.data).join('');

    expect(output).toContain('Chunk 1');
    expect(output).toContain('Chunk 2');
    expect(output).toContain('Chunk 3');
    expect(output).toContain('DONE');

    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.exitCode).toBe(0);
  }, 15000);
});
