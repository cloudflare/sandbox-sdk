/**
 * Bursty Traffic Test
 *
 * Simulates sudden spikes in load by sending rapid bursts of requests.
 * Measures recovery time and success rate under pressure.
 */

import { afterAll, describe, expect, test } from 'vitest';
import { runBurst } from '../helpers/concurrent-runner';
import { METRICS, SCENARIOS } from '../helpers/constants';
import type { SandboxInstance } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Bursty Traffic', () => {
  const ctx = createPerfTestContext(SCENARIOS.BURST);
  let sandbox: SandboxInstance;

  const BURST_SIZE = 50;
  const BURST_STAGGER_MS = 5;
  const BURSTS_COUNT = 3;
  const COOLDOWN_SECONDS = 30;

  afterAll(async () => {
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test(`should handle ${BURSTS_COUNT} bursts of ${BURST_SIZE} concurrent requests`, async () => {
    // Create and warm up sandbox
    sandbox = await ctx.manager.createSandbox({ initialize: true });

    console.log(
      `\nBursty traffic: ${BURSTS_COUNT} bursts of ${BURST_SIZE} requests`
    );

    for (let burstNum = 0; burstNum < BURSTS_COUNT; burstNum++) {
      // Pre-burst baseline
      const baselineResult = await ctx.manager.executeCommand(
        sandbox,
        'echo "baseline"'
      );
      ctx.collector.record(
        METRICS.BASELINE_LATENCY,
        baselineResult.duration,
        'ms',
        {
          burst: burstNum,
          phase: 'pre'
        }
      );

      // Execute burst
      const burstStart = performance.now();
      const burstResults = await runBurst(
        () => ctx.manager.executeCommand(sandbox, 'echo "burst"'),
        BURST_SIZE,
        { staggerMs: BURST_STAGGER_MS }
      );
      const burstDuration = performance.now() - burstStart;

      // Record burst metrics
      for (const result of burstResults.results) {
        if ('result' in result) {
          ctx.collector.record(METRICS.BURST_COMMAND, result.duration, 'ms', {
            success: result.result.success,
            burst: burstNum
          });
        } else {
          ctx.collector.record(METRICS.BURST_COMMAND, result.duration, 'ms', {
            success: false,
            burst: burstNum,
            error: result.error.message
          });
        }
      }

      ctx.collector.record(METRICS.BURST_DURATION, burstDuration, 'ms', {
        burst: burstNum
      });

      const successRate = (burstResults.successCount / BURST_SIZE) * 100;
      ctx.collector.record(METRICS.BURST_SUCCESS_RATE, successRate, 'percent', {
        burst: burstNum
      });

      console.log(
        `  Burst ${burstNum + 1}: ${burstResults.successCount}/${BURST_SIZE} (${successRate.toFixed(0)}%)`
      );

      // Post-burst recovery
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const recoveryResult = await ctx.manager.executeCommand(
        sandbox,
        'echo "recovery"'
      );
      ctx.collector.record(
        METRICS.RECOVERY_LATENCY,
        recoveryResult.duration,
        'ms',
        {
          burst: burstNum,
          phase: 'post'
        }
      );

      // Cooldown
      if (burstNum < BURSTS_COUNT - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, COOLDOWN_SECONDS * 1000)
        );
      }
    }

    // Calculate overall stats
    const successRates = ctx.collector.getMeasurements(
      METRICS.BURST_SUCCESS_RATE
    );
    const avgSuccessRate =
      successRates.reduce((sum, m) => sum + m.value, 0) / successRates.length;

    const baselineLatencies = ctx.collector.getMeasurements(
      METRICS.BASELINE_LATENCY
    );
    const recoveryLatencies = ctx.collector.getMeasurements(
      METRICS.RECOVERY_LATENCY
    );
    const avgBaseline =
      baselineLatencies.reduce((sum, m) => sum + m.value, 0) /
      baselineLatencies.length;
    const avgRecovery =
      recoveryLatencies.reduce((sum, m) => sum + m.value, 0) /
      recoveryLatencies.length;
    const recoveryOverhead = ((avgRecovery - avgBaseline) / avgBaseline) * 100;

    ctx.collector.record(
      METRICS.RECOVERY_OVERHEAD,
      recoveryOverhead,
      'percent'
    );

    console.log(
      `  Average success: ${avgSuccessRate.toFixed(1)}%, recovery overhead: ${recoveryOverhead.toFixed(1)}%`
    );

    expect(avgSuccessRate).toBeGreaterThan(70);
    expect(recoveryOverhead).toBeLessThan(200);
  }, 300000);
});
