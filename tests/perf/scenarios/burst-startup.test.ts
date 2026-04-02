/**
 * Burst Startup Test
 *
 * Measures sandbox creation performance under burst load: sandboxes are
 * created in rapid succession with a small stagger between each launch,
 * simulating a sudden influx of users each needing a fresh sandbox.
 *
 * Contrast with concurrent-creation, which starts all sandboxes
 * simultaneously at T=0; this test staggers launches to model realistic
 * traffic bursts and measures how the platform handles the overlapping
 * creation queue.
 */

import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { runBurst } from '../helpers/concurrent-runner';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import { PerfSandboxManager } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Burst Startup', () => {
  const ctx = createPerfTestContext(SCENARIOS.BURST_STARTUP);
  const managers: PerfSandboxManager[] = [];

  const BURST_SIZE = 20;
  const STAGGER_MS = 10;

  afterEach(async () => {
    await Promise.allSettled(managers.map((m) => m.destroyAll()));
    managers.length = 0;
  });

  afterAll(() => {
    registerPerfScenario(ctx);
  });

  test(`should start ${BURST_SIZE} sandboxes in a burst (${STAGGER_MS}ms stagger)`, async () => {
    console.log(
      `\nBurst startup: ${BURST_SIZE} sandboxes, ${STAGGER_MS}ms stagger`
    );

    const overallStart = performance.now();

    const results = await runBurst(
      async () => {
        const manager = new PerfSandboxManager({ workerUrl: ctx.workerUrl });
        managers.push(manager);

        const sandbox = await manager.createSandbox();
        const result = await manager.executeCommand(sandbox, 'echo "ready"', {
          timeout: 120000
        });

        return { success: result.success, sandboxId: sandbox.id };
      },
      BURST_SIZE,
      { staggerMs: STAGGER_MS, maxDuration: 300000 }
    );

    const overallDuration = performance.now() - overallStart;

    for (const r of results.results) {
      if ('result' in r) {
        ctx.collector.record(METRICS.BURST_STARTUP_LATENCY, r.duration, 'ms', {
          success: r.result.success,
          index: r.index
        });
      } else {
        ctx.collector.record(METRICS.BURST_STARTUP_LATENCY, r.duration, 'ms', {
          success: false,
          index: r.index,
          error: r.error.message
        });
      }
    }

    ctx.collector.record(
      METRICS.BURST_STARTUP_TOTAL_TIME,
      overallDuration,
      'ms',
      { sandboxCount: BURST_SIZE }
    );

    const successRate = (results.successCount / BURST_SIZE) * 100;
    ctx.collector.record(
      METRICS.BURST_STARTUP_SUCCESS_RATE,
      successRate,
      'percent'
    );

    const stats = ctx.collector.getStats(METRICS.BURST_STARTUP_LATENCY);
    console.log(
      `  Completed: ${results.successCount}/${BURST_SIZE} (${successRate.toFixed(0)}%)`
    );
    if (stats) {
      console.log(
        `  P50: ${stats.p50.toFixed(0)}ms  P95: ${stats.p95.toFixed(0)}ms`
      );
    }
    console.log(`  Wall time: ${(overallDuration / 1000).toFixed(2)}s`);

    expect(successRate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);
});
