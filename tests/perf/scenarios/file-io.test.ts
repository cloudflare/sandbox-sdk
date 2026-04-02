/**
 * File I/O Performance Test
 *
 * Measures read and write latencies across multiple file sizes and access patterns:
 * - Sequential writes and reads at 1 KB, 10 KB, 100 KB, and 1 MB
 * - Write → read roundtrip latency per size
 * - Concurrent writes and reads (10 simultaneous operations)
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runConcurrent } from '../helpers/concurrent-runner';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import type { SandboxInstance } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('File I/O', () => {
  const ctx = createPerfTestContext(SCENARIOS.FILE_IO);
  let sandbox: SandboxInstance;

  const ITERATIONS = 20;
  const CONCURRENT_OPS = 10;

  const FILE_SIZES: Array<{ label: string; bytes: number }> = [
    { label: '1kb', bytes: 1_024 },
    { label: '10kb', bytes: 10_240 },
    { label: '100kb', bytes: 102_400 },
    { label: '1mb', bytes: 1_048_576 }
  ];

  function generateContent(bytes: number): string {
    const chunk = 'abcdefghijklmnopqrstuvwxyz0123456789\n';
    return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes);
  }

  beforeAll(async () => {
    sandbox = await ctx.manager.createSandbox({ initialize: true });
    await ctx.manager.executeCommand(sandbox, 'mkdir -p /tmp/perf-fileio');
  }, 120000);

  afterAll(async () => {
    await ctx.manager.executeCommand(sandbox, 'rm -rf /tmp/perf-fileio');
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test('should measure sequential write and read latency by file size', async () => {
    for (const { label, bytes } of FILE_SIZES) {
      const content = generateContent(bytes);
      console.log(`\n  Sequential I/O ${label} (${ITERATIONS} iterations):`);

      for (let i = 0; i < ITERATIONS; i++) {
        const path = `/tmp/perf-fileio/seq-${label}-${i}.txt`;

        const writeResult = await ctx.manager.writeFile(sandbox, path, content);
        ctx.collector.record(
          `${METRICS.FILE_WRITE_LATENCY}-${label}`,
          writeResult.duration,
          'ms',
          { success: writeResult.success, iteration: i }
        );

        if (writeResult.success) {
          const readResult = await ctx.manager.readFile(sandbox, path);
          const readSuccess =
            readResult.success && readResult.content === content;
          ctx.collector.record(
            `${METRICS.FILE_READ_LATENCY}-${label}`,
            readResult.duration,
            'ms',
            {
              success: readSuccess,
              iteration: i,
              error:
                readResult.success && readResult.content !== content
                  ? 'Content mismatch'
                  : readResult.error
            }
          );
        }
      }

      const writeStats = ctx.collector.getStats(
        `${METRICS.FILE_WRITE_LATENCY}-${label}`
      );
      const readStats = ctx.collector.getStats(
        `${METRICS.FILE_READ_LATENCY}-${label}`
      );
      if (writeStats) {
        console.log(
          `    Write p50=${writeStats.p50.toFixed(0)}ms  p95=${writeStats.p95.toFixed(0)}ms`
        );
      }
      if (readStats) {
        console.log(
          `    Read  p50=${readStats.p50.toFixed(0)}ms  p95=${readStats.p95.toFixed(0)}ms`
        );
      }
    }

    const smallWriteRate = ctx.collector.getSuccessRate(
      `${METRICS.FILE_WRITE_LATENCY}-1kb`
    );
    expect(smallWriteRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    const largeWriteRate = ctx.collector.getSuccessRate(
      `${METRICS.FILE_WRITE_LATENCY}-1mb`
    );
    expect(largeWriteRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    const smallReadRate = ctx.collector.getSuccessRate(
      `${METRICS.FILE_READ_LATENCY}-1kb`
    );
    expect(smallReadRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    const largeReadRate = ctx.collector.getSuccessRate(
      `${METRICS.FILE_READ_LATENCY}-1mb`
    );
    expect(largeReadRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);

  test('should measure write→read roundtrip latency by file size', async () => {
    console.log(`\n  Roundtrip (write+read) latency:`);

    for (const { label, bytes } of FILE_SIZES) {
      const content = generateContent(bytes);

      for (let i = 0; i < ITERATIONS; i++) {
        const path = `/tmp/perf-fileio/rt-${label}-${i}.txt`;

        const start = performance.now();
        const writeResult = await ctx.manager.writeFile(sandbox, path, content);
        let roundtripSuccess = false;
        if (writeResult.success) {
          const readResult = await ctx.manager.readFile(sandbox, path);
          roundtripSuccess =
            readResult.success && readResult.content === content;
        }
        const roundtrip = performance.now() - start;

        ctx.collector.record(
          `${METRICS.FILE_ROUNDTRIP_LATENCY}-${label}`,
          roundtrip,
          'ms',
          { success: roundtripSuccess, iteration: i }
        );
      }

      const rtStats = ctx.collector.getStats(
        `${METRICS.FILE_ROUNDTRIP_LATENCY}-${label}`
      );
      if (rtStats) {
        console.log(
          `    ${label}: p50=${rtStats.p50.toFixed(0)}ms  p95=${rtStats.p95.toFixed(0)}ms`
        );
      }
    }

    const rtStats = ctx.collector.getStats(
      `${METRICS.FILE_ROUNDTRIP_LATENCY}-1kb`
    );
    expect(rtStats).not.toBeNull();
    expect(rtStats!.count).toBe(ITERATIONS);
  }, 600000);

  test(`should measure concurrent file I/O (${CONCURRENT_OPS} simultaneous ops)`, async () => {
    console.log(`\n  Concurrent I/O (${CONCURRENT_OPS} ops):`);

    // Skip 1 MB for concurrent — focus on the sizes that stress the scheduler
    for (const { label, bytes } of FILE_SIZES.slice(0, 3)) {
      const content = generateContent(bytes);

      const writeOps = Array.from({ length: CONCURRENT_OPS }, (_, i) => {
        return async () => {
          const path = `/tmp/perf-fileio/conc-${label}-${i}.txt`;
          return ctx.manager.writeFile(sandbox, path, content);
        };
      });

      const writeResults = await runConcurrent(writeOps);

      for (const r of writeResults.results) {
        if ('result' in r) {
          ctx.collector.record(
            `${METRICS.FILE_CONCURRENT_WRITE}-${label}`,
            r.duration,
            'ms',
            { success: r.result.success, index: r.index }
          );
        } else {
          ctx.collector.record(
            `${METRICS.FILE_CONCURRENT_WRITE}-${label}`,
            r.duration,
            'ms',
            { success: false, index: r.index }
          );
        }
      }

      const readOps = Array.from({ length: CONCURRENT_OPS }, (_, i) => {
        return async () => {
          const path = `/tmp/perf-fileio/conc-${label}-${i}.txt`;
          return ctx.manager.readFile(sandbox, path);
        };
      });

      const readResults = await runConcurrent(readOps);

      for (const r of readResults.results) {
        if ('result' in r) {
          ctx.collector.record(
            `${METRICS.FILE_CONCURRENT_READ}-${label}`,
            r.duration,
            'ms',
            { success: r.result.success, index: r.index }
          );
        } else {
          ctx.collector.record(
            `${METRICS.FILE_CONCURRENT_READ}-${label}`,
            r.duration,
            'ms',
            { success: false, index: r.index }
          );
        }
      }

      const writeStats = ctx.collector.getStats(
        `${METRICS.FILE_CONCURRENT_WRITE}-${label}`
      );
      const readStats = ctx.collector.getStats(
        `${METRICS.FILE_CONCURRENT_READ}-${label}`
      );
      console.log(
        `    ${label}: writes ${writeResults.successCount}/${CONCURRENT_OPS}` +
          (writeStats ? ` p95=${writeStats.p95.toFixed(0)}ms` : '') +
          `  reads ${readResults.successCount}/${CONCURRENT_OPS}` +
          (readStats ? ` p95=${readStats.p95.toFixed(0)}ms` : '')
      );
    }

    const concWriteRate = ctx.collector.getSuccessRate(
      `${METRICS.FILE_CONCURRENT_WRITE}-1kb`
    );
    expect(concWriteRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    const concReadRate = ctx.collector.getSuccessRate(
      `${METRICS.FILE_CONCURRENT_READ}-1kb`
    );
    expect(concReadRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);
});
