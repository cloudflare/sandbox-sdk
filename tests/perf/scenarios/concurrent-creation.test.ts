/**
 * Concurrent Sandbox Creation Test
 *
 * Measures the ability to spin up multiple sandboxes simultaneously.
 * Target: ~25 sandboxes with measurement of success rate and timing.
 */

import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { runConcurrent } from '../helpers/concurrent-runner';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import { PerfSandboxManager } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Concurrent Sandbox Creation', () => {
  const ctx = createPerfTestContext(SCENARIOS.CONCURRENT);
  const managers: PerfSandboxManager[] = [];

  const CONCURRENT_SANDBOXES = 25;
  const CREATION_TIMEOUT = 120000;

  afterEach(async () => {
    // Clean up all managers on test completion or failure
    await Promise.allSettled(managers.map((m) => m.destroyAll()));
    managers.length = 0;
  });

  afterAll(() => {
    registerPerfScenario(ctx);
  });

  test(`should create ${CONCURRENT_SANDBOXES} sandboxes concurrently`, async () => {
    console.log(`\nConcurrent creation: ${CONCURRENT_SANDBOXES} sandboxes`);

    const operations = Array.from({ length: CONCURRENT_SANDBOXES }, (_, i) => {
      return async () => {
        const manager = new PerfSandboxManager({ workerUrl: ctx.workerUrl });
        managers.push(manager);

        const start = performance.now();
        const sandbox = await manager.createSandbox();

        // Execute a command to confirm sandbox is ready
        const result = await manager.executeCommand(sandbox, 'echo "ready"', {
          timeout: CREATION_TIMEOUT
        });

        const duration = performance.now() - start;

        ctx.collector.record(METRICS.SANDBOX_CREATION, duration, 'ms', {
          success: result.success,
          sandboxId: sandbox.id,
          index: i
        });

        if (!result.success) {
          throw new Error(`Sandbox ${i} failed: ${result.stderr}`);
        }

        return { sandboxId: sandbox.id, duration };
      };
    });

    const overallStart = performance.now();
    const results = await runConcurrent(operations);
    const overallDuration = performance.now() - overallStart;

    ctx.collector.record(METRICS.TOTAL_CONCURRENT_TIME, overallDuration, 'ms', {
      sandboxCount: CONCURRENT_SANDBOXES
    });

    console.log(`  Total time: ${(overallDuration / 1000).toFixed(2)}s`);
    console.log(`  Success: ${results.successCount}/${CONCURRENT_SANDBOXES}`);

    const successRate = (results.successCount / CONCURRENT_SANDBOXES) * 100;
    ctx.collector.record(METRICS.SUCCESS_RATE, successRate, 'percent');

    expect(successRate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    expect(overallDuration).toBeLessThan(300000);
  }, 600000);
});
