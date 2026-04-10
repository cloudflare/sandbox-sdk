/**
 * Bucket Mounting Performance Test
 *
 * Measures mount/unmount latency and file I/O performance through both:
 * - Local flow: R2 binding sync (no FUSE), triggered by localBucket: true
 * - Production flow: s3fs FUSE mount, triggered by endpoint URL
 *
 * Each flow is measured independently on its own sandbox to avoid state bleed.
 *
 * Requires CI environment (TEST_WORKER_URL) with TEST_BUCKET R2 binding.
 * Production flow additionally requires CLOUDFLARE_ACCOUNT_ID + AWS credentials.
 */

import { afterAll, describe, test } from 'vitest';
import { METRICS, SCENARIOS } from '../helpers/constants';
import { getWorkerUrl } from '../helpers/get-worker-url';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Bucket Mounting Performance', () => {
  let _workerUrl: string | null = null;
  try {
    _workerUrl = getWorkerUrl();
  } catch {}

  if (!_workerUrl) {
    test.skip('Skipping — requires a running perf environment (global-setup must have run)', () => {});
    return;
  }

  const ctx = createPerfTestContext(SCENARIOS.BUCKET_MOUNTING);

  const ITERATIONS = 5;
  const TEST_BUCKET = 'sandbox-e2e-test';
  const FILE_SIZES: Array<{ label: string; ddCount: number }> = [
    { label: '1kb', ddCount: 1 },
    { label: '100kb', ddCount: 100 }
  ];

  afterAll(async () => {
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test('mount/unmount and file I/O — local flow (R2 binding sync)', async () => {
    const sandbox = await ctx.manager.createSandbox({ initialize: true });

    console.log(
      `\nBucket mount local: ${ITERATIONS} iterations × ${FILE_SIZES.length} sizes`
    );

    let localAvailable = true;

    for (const { label, ddCount } of FILE_SIZES) {
      if (!localAvailable) break;

      for (let i = 0; i < ITERATIONS; i++) {
        const mountPath = `/workspace/mnt/perf-local-${label}-${i}`;
        const testKey = `perf-local-${Date.now()}-${i}.txt`;
        const fullFilePath = `${mountPath}/${testKey}`;

        await ctx.manager.executeCommand(sandbox, `mkdir -p ${mountPath}`);

        // Measure mount
        const mountResult = await ctx.manager.mountBucket(
          sandbox,
          'TEST_BUCKET',
          mountPath,
          { localBucket: true }
        );

        if (!mountResult.success) {
          console.warn(
            `  [local ${label} iter ${i}] Mount failed: ${mountResult.error}`
          );
          localAvailable = false;
          break;
        }

        ctx.collector.record(
          `${METRICS.MOUNT_LATENCY}-local`,
          mountResult.duration,
          'ms',
          { success: true, size: label, iteration: i }
        );

        // Measure write through mount
        const writeStart = performance.now();
        const writeResult = await ctx.manager.executeCommand(
          sandbox,
          `dd if=/dev/zero bs=1024 count=${ddCount} 2>/dev/null | tr '\\0' 'x' > ${fullFilePath}`
        );
        const writeDuration = performance.now() - writeStart;

        ctx.collector.record(
          `${METRICS.MOUNT_IO_WRITE_LATENCY}-local-${label}`,
          writeDuration,
          'ms',
          { success: writeResult.exitCode === 0, iteration: i }
        );

        // Measure read through mount (discard output to measure pure I/O latency)
        const readStart = performance.now();
        const readResult = await ctx.manager.executeCommand(
          sandbox,
          `cat ${fullFilePath} > /dev/null`
        );
        const readDuration = performance.now() - readStart;

        ctx.collector.record(
          `${METRICS.MOUNT_IO_READ_LATENCY}-local-${label}`,
          readDuration,
          'ms',
          { success: readResult.exitCode === 0, iteration: i }
        );

        // Measure unmount
        const unmountResult = await ctx.manager.unmountBucket(
          sandbox,
          mountPath
        );
        ctx.collector.record(
          `${METRICS.UNMOUNT_LATENCY}-local`,
          unmountResult.duration,
          'ms',
          { success: unmountResult.success, size: label, iteration: i }
        );

        // Best-effort R2 cleanup
        await fetch(`${ctx.workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers: sandbox.headers,
          body: JSON.stringify({ key: testKey })
        }).catch(() => {});
      }

      const mountStats = ctx.collector.getStats(
        `${METRICS.MOUNT_LATENCY}-local`
      );
      const writeStats = ctx.collector.getStats(
        `${METRICS.MOUNT_IO_WRITE_LATENCY}-local-${label}`
      );
      const readStats = ctx.collector.getStats(
        `${METRICS.MOUNT_IO_READ_LATENCY}-local-${label}`
      );
      console.log(
        `  ${label}: mount p50=${mountStats?.p50.toFixed(0) ?? 'n/a'}ms` +
          `  write p50=${writeStats?.p50.toFixed(0) ?? 'n/a'}ms` +
          `  read p50=${readStats?.p50.toFixed(0) ?? 'n/a'}ms`
      );
    }

    if (!localAvailable) {
      console.warn(
        '  Local mount unavailable — TEST_BUCKET binding may not be configured'
      );
      return;
    }

    const mountRate = ctx.collector.getSuccessRate(
      `${METRICS.MOUNT_LATENCY}-local`
    );
    console.log(
      `  local mount success rate: ${(mountRate.rate * 100).toFixed(0)}%`
    );
  }, 600000);

  test('mount/unmount and file I/O — production flow (FUSE/s3fs)', async () => {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
      console.log(
        '  Skipping — CLOUDFLARE_ACCOUNT_ID not set (production mount requires R2 endpoint)'
      );
      return;
    }

    const sandbox = await ctx.manager.createSandbox({ initialize: true });
    const endpoint = `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;

    console.log(
      `\nBucket mount production: ${ITERATIONS} iterations × ${FILE_SIZES.length} sizes`
    );

    for (const { label, ddCount } of FILE_SIZES) {
      for (let i = 0; i < ITERATIONS; i++) {
        const mountPath = `/workspace/mnt/perf-prod-${label}-${i}`;
        const testKey = `perf-prod-${Date.now()}-${i}.txt`;
        const fullFilePath = `${mountPath}/${testKey}`;

        await ctx.manager.executeCommand(sandbox, `mkdir -p ${mountPath}`);

        const mountResult = await ctx.manager.mountBucket(
          sandbox,
          TEST_BUCKET,
          mountPath,
          { endpoint }
        );

        if (!mountResult.success) {
          console.warn(
            `  [prod ${label} iter ${i}] Mount failed: ${mountResult.error}`
          );
          continue;
        }

        ctx.collector.record(
          `${METRICS.MOUNT_LATENCY}-prod`,
          mountResult.duration,
          'ms',
          { success: true, size: label, iteration: i }
        );

        // Measure write through FUSE mount
        const writeStart = performance.now();
        const writeResult = await ctx.manager.executeCommand(
          sandbox,
          `dd if=/dev/zero bs=1024 count=${ddCount} 2>/dev/null | tr '\\0' 'x' > ${fullFilePath}`
        );
        const writeDuration = performance.now() - writeStart;

        ctx.collector.record(
          `${METRICS.MOUNT_IO_WRITE_LATENCY}-prod-${label}`,
          writeDuration,
          'ms',
          { success: writeResult.exitCode === 0, iteration: i }
        );

        // Measure read through FUSE mount
        const readStart = performance.now();
        const readResult = await ctx.manager.executeCommand(
          sandbox,
          `cat ${fullFilePath} > /dev/null`
        );
        const readDuration = performance.now() - readStart;

        ctx.collector.record(
          `${METRICS.MOUNT_IO_READ_LATENCY}-prod-${label}`,
          readDuration,
          'ms',
          { success: readResult.exitCode === 0, iteration: i }
        );

        const unmountResult = await ctx.manager.unmountBucket(
          sandbox,
          mountPath
        );
        ctx.collector.record(
          `${METRICS.UNMOUNT_LATENCY}-prod`,
          unmountResult.duration,
          'ms',
          { success: unmountResult.success, size: label, iteration: i }
        );

        // Best-effort R2 cleanup
        await fetch(`${ctx.workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers: sandbox.headers,
          body: JSON.stringify({ key: testKey })
        }).catch(() => {});
      }

      const writeStats = ctx.collector.getStats(
        `${METRICS.MOUNT_IO_WRITE_LATENCY}-prod-${label}`
      );
      const readStats = ctx.collector.getStats(
        `${METRICS.MOUNT_IO_READ_LATENCY}-prod-${label}`
      );
      console.log(
        `  ${label}: write p50=${writeStats?.p50.toFixed(0) ?? 'n/a'}ms` +
          `  read p50=${readStats?.p50.toFixed(0) ?? 'n/a'}ms`
      );
    }

    const mountRate = ctx.collector.getSuccessRate(
      `${METRICS.MOUNT_LATENCY}-prod`
    );
    console.log(
      `  prod mount success rate: ${(mountRate.rate * 100).toFixed(0)}%`
    );
  }, 600000);
});
