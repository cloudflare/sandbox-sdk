/**
 * Cold Start Latency Test
 *
 * Measures the time to create a fresh sandbox and execute the first command.
 * This includes container provisioning, runtime initialization, and network latency.
 */

import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { METRICS, SCENARIOS } from '../helpers/constants';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Cold Start Latency', () => {
  const ctx = createPerfTestContext(SCENARIOS.COLD_START);

  const ITERATIONS = 10;
  const WARMUP_ITERATIONS = 2;

  afterEach(async () => {
    await ctx.manager.destroyAll();
  });

  afterAll(() => {
    registerPerfScenario(ctx);
  });

  test('should measure cold start latency across multiple iterations', async () => {
    console.log(
      `\nCold start: ${ITERATIONS} iterations (${WARMUP_ITERATIONS} warmup)`
    );

    // Warmup runs (not recorded)
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      const sandbox = await ctx.manager.createSandbox();
      await ctx.manager.executeCommand(sandbox, 'echo "warmup"');
      await ctx.manager.destroySandbox(sandbox);
    }

    // Measured runs
    for (let i = 0; i < ITERATIONS; i++) {
      const sandbox = await ctx.manager.createSandbox();

      // Measure time to first successful command
      const start = performance.now();
      const result = await ctx.manager.executeCommand(
        sandbox,
        'echo "cold-start-test"'
      );
      const coldStartLatency = performance.now() - start;

      ctx.collector.record(METRICS.COLD_START_LATENCY, coldStartLatency, 'ms', {
        success: result.success,
        sandboxId: sandbox.id,
        iteration: i + 1
      });

      // Also measure a follow-up "warm" command for comparison
      if (result.success) {
        await ctx.collector.timeAsync(
          METRICS.WARM_COMMAND_LATENCY,
          () => ctx.manager.executeCommand(sandbox, 'echo "warm-test"'),
          { iteration: i + 1 }
        );
      }

      await ctx.manager.destroySandbox(sandbox);
    }

    // Verify we got data
    const stats = ctx.collector.getStats(METRICS.COLD_START_LATENCY);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(ITERATIONS);

    const successRate = ctx.collector.getSuccessRate(
      METRICS.COLD_START_LATENCY
    );
    expect(successRate.rate).toBeGreaterThan(80);
  }, 600000);
});
