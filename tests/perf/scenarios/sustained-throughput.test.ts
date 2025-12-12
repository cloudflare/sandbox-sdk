/**
 * Sustained Throughput Test
 *
 * Measures performance over extended periods with continuous command execution.
 * Tracks p50/p95/p99 latencies and identifies degradation over time.
 */

import { afterAll, describe, expect, test } from 'vitest';
import { METRICS, SCENARIOS } from '../helpers/constants';
import type { SandboxInstance } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Sustained Throughput', () => {
  const ctx = createPerfTestContext(SCENARIOS.SUSTAINED);
  let sandbox: SandboxInstance;

  const DURATION_SECONDS = 60;
  const COMMANDS_PER_SECOND = 5;

  afterAll(async () => {
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test(`should sustain ${COMMANDS_PER_SECOND} commands/second for ${DURATION_SECONDS} seconds`, async () => {
    // Create and warm up sandbox
    sandbox = await ctx.manager.createSandbox({ initialize: true });

    const totalCommands = DURATION_SECONDS * COMMANDS_PER_SECOND;
    console.log(
      `\nSustained throughput: ${totalCommands} commands over ${DURATION_SECONDS}s`
    );

    const intervalMs = 1000 / COMMANDS_PER_SECOND;
    const commands = [
      'echo "test"',
      'date +%s%N',
      'hostname',
      'pwd',
      'ls /workspace'
    ];

    const startTime = Date.now();
    let commandIndex = 0;
    let completedCommands = 0;
    let failedCommands = 0;

    while (Date.now() - startTime < DURATION_SECONDS * 1000) {
      const iterationStart = performance.now();

      const command = commands[commandIndex % commands.length];
      const result = await ctx.manager.executeCommand(sandbox, command);

      ctx.collector.record(METRICS.COMMAND_LATENCY, result.duration, 'ms', {
        success: result.success,
        command,
        elapsedSec: Math.floor((Date.now() - startTime) / 1000)
      });

      if (result.success) {
        completedCommands++;
      } else {
        failedCommands++;
      }

      commandIndex++;

      // Rate limiting
      const elapsed = performance.now() - iterationStart;
      if (elapsed < intervalMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, intervalMs - elapsed)
        );
      }

      // Progress every 20 seconds
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      if (
        elapsedSec > 0 &&
        elapsedSec % 20 === 0 &&
        commandIndex % COMMANDS_PER_SECOND === 0
      ) {
        console.log(
          `  ${elapsedSec}s: ${completedCommands} completed, ${failedCommands} failed`
        );
      }
    }

    const totalDuration = Date.now() - startTime;
    const actualThroughput = completedCommands / (totalDuration / 1000);

    ctx.collector.record(METRICS.TOTAL_COMMANDS, commandIndex, 'count');
    ctx.collector.record(
      METRICS.COMPLETED_COMMANDS,
      completedCommands,
      'count'
    );
    ctx.collector.record(METRICS.ACTUAL_THROUGHPUT, actualThroughput, 'ops/s');

    console.log(
      `  Completed: ${completedCommands}/${commandIndex}, throughput: ${actualThroughput.toFixed(2)} ops/s`
    );

    // Analyze degradation
    const measurements = ctx.collector.getMeasurements(METRICS.COMMAND_LATENCY);
    const firstQuarter = measurements.slice(
      0,
      Math.floor(measurements.length / 4)
    );
    const lastQuarter = measurements.slice(
      Math.floor(measurements.length * 0.75)
    );

    const avgFirst =
      firstQuarter.reduce((sum, m) => sum + m.value, 0) / firstQuarter.length;
    const avgLast =
      lastQuarter.reduce((sum, m) => sum + m.value, 0) / lastQuarter.length;
    const degradation = ((avgLast - avgFirst) / avgFirst) * 100;

    ctx.collector.record(METRICS.LATENCY_DEGRADATION, degradation, 'percent');

    const successRate = (completedCommands / commandIndex) * 100;
    expect(successRate).toBeGreaterThan(95);
    expect(degradation).toBeLessThan(100);
  }, 180000);
});
