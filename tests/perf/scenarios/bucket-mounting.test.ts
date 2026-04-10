/**
 * Bucket Mounting Performance Test
 *
 * Measures latency for both mount paths:
 * - FUSE (s3fs-FUSE, production path via S3-compatible credentials)
 * - Local Sync (R2 binding, local dev path via localBucket: true)
 *
 * Metrics collected per path:
 * - Mount latency
 * - Write latency (file written via mounted path)
 * - Read latency (file read via mounted path)
 * - Write→Read roundtrip latency
 * - Unmount latency
 * - Total lifecycle latency (mount + I/O + unmount)
 *
 * Requires environment variables for the FUSE path:
 *   CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *
 * The local-sync path uses the R2 binding (TEST_BUCKET) configured in the
 * perf wrangler template — no S3 credentials needed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import type { SandboxInstance } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

const PERF_BUCKET_NAME = process.env.PERF_BUCKET_NAME || 'sandbox-perf-test';

interface MountPath {
  label: string;
  mountOptions: Record<string, unknown>;
  /** Files created during tests — cleaned up after each iteration */
  cleanupKeys: string[];
}

function getFuseMountPath(): MountPath | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    label: 'fuse',
    mountOptions: {
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`
    },
    cleanupKeys: []
  };
}

function getLocalSyncMountPath(): MountPath {
  return {
    label: 'local-sync',
    mountOptions: {
      localBucket: true
    },
    cleanupKeys: []
  };
}

describe('Bucket Mounting', () => {
  const ctx = createPerfTestContext(SCENARIOS.BUCKET_MOUNTING);
  let sandbox: SandboxInstance;

  const ITERATIONS = 5;
  const MOUNT_BASE = '/workspace/perf-mount';

  const FILE_SIZES: Array<{ label: string; bytes: number }> = [
    { label: '1kb', bytes: 1_024 },
    { label: '10kb', bytes: 10_240 },
    { label: '100kb', bytes: 102_400 }
  ];

  function generateContent(bytes: number): string {
    const chunk = 'abcdefghijklmnopqrstuvwxyz0123456789\n';
    return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes);
  }

  beforeAll(async () => {
    sandbox = await ctx.manager.createSandbox({ initialize: true });
  }, 120_000);

  afterAll(async () => {
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  /**
   * Run the full mount lifecycle for a given path (fuse or local-sync):
   * 1. Mount
   * 2. Write files via exec (echo > mount_path/file)
   * 3. Read files via exec (cat mount_path/file)
   * 4. Write→Read roundtrip
   * 5. Unmount
   * 6. Record total lifecycle latency
   */
  async function runMountLifecycle(mp: MountPath): Promise<void> {
    const { label } = mp;
    const mountPath = `${MOUNT_BASE}-${label}`;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const totalStart = performance.now();
      const iterLabel = `iter=${iter}`;

      // --- Mount ---
      console.log(`    [${label}] ${iterLabel} mounting...`);
      const mountResult = await ctx.manager.mountBucket(
        sandbox,
        label === 'local-sync' ? 'TEST_BUCKET' : PERF_BUCKET_NAME,
        mountPath,
        mp.mountOptions
      );
      ctx.collector.record(
        `${METRICS.BUCKET_MOUNT_LATENCY}-${label}`,
        mountResult.duration,
        'ms',
        { success: mountResult.success, iteration: iter }
      );

      if (!mountResult.success) {
        console.warn(
          `    [${label}] ${iterLabel} mount failed: ${mountResult.error}`
        );
        ctx.collector.record(
          `${METRICS.BUCKET_TOTAL_LATENCY}-${label}`,
          performance.now() - totalStart,
          'ms',
          { success: false, iteration: iter }
        );
        continue;
      }

      // --- Write via exec ---
      for (const { label: sizeLabel, bytes } of FILE_SIZES) {
        const content = generateContent(bytes);
        const filePath = `${mountPath}/perf-${label}-${sizeLabel}-${iter}.txt`;
        const key = `perf-${label}-${sizeLabel}-${iter}.txt`;
        mp.cleanupKeys.push(key);

        const writeStart = performance.now();
        const writeResp = await ctx.manager.executeCommand(
          sandbox,
          `cat > ${filePath} << 'PERFEOF'\n${content}\nPERFEOF`
        );
        const writeDuration = performance.now() - writeStart;
        const writeSuccess = writeResp.success && writeResp.exitCode === 0;

        ctx.collector.record(
          `${METRICS.BUCKET_WRITE_LATENCY}-${label}-${sizeLabel}`,
          writeDuration,
          'ms',
          { success: writeSuccess, iteration: iter }
        );
      }

      // --- Read via exec ---
      for (const { label: sizeLabel, bytes } of FILE_SIZES) {
        const filePath = `${mountPath}/perf-${label}-${sizeLabel}-${iter}.txt`;

        const readStart = performance.now();
        const readResp = await ctx.manager.executeCommand(
          sandbox,
          `cat ${filePath}`
        );
        const readDuration = performance.now() - readStart;
        const readSuccess = readResp.success && readResp.exitCode === 0;

        ctx.collector.record(
          `${METRICS.BUCKET_READ_LATENCY}-${label}-${sizeLabel}`,
          readDuration,
          'ms',
          { success: readSuccess, iteration: iter }
        );
      }

      // --- Roundtrip (write + immediate read, 1kb only) ---
      {
        const rtContent = generateContent(1_024);
        const rtPath = `${mountPath}/perf-rt-${label}-${iter}.txt`;
        const rtKey = `perf-rt-${label}-${iter}.txt`;
        mp.cleanupKeys.push(rtKey);

        const rtStart = performance.now();
        const rtWrite = await ctx.manager.executeCommand(
          sandbox,
          `cat > ${rtPath} << 'PERFEOF'\n${rtContent}\nPERFEOF`
        );
        let rtSuccess = rtWrite.success && rtWrite.exitCode === 0;
        if (rtSuccess) {
          const rtRead = await ctx.manager.executeCommand(
            sandbox,
            `cat ${rtPath}`
          );
          rtSuccess = rtRead.success && rtRead.exitCode === 0;
        }
        const rtDuration = performance.now() - rtStart;

        ctx.collector.record(
          `${METRICS.BUCKET_ROUNDTRIP_LATENCY}-${label}`,
          rtDuration,
          'ms',
          { success: rtSuccess, iteration: iter }
        );
      }

      // --- Unmount ---
      console.log(`    [${label}] ${iterLabel} unmounting...`);
      const unmountResult = await ctx.manager.unmountBucket(sandbox, mountPath);
      ctx.collector.record(
        `${METRICS.BUCKET_UNMOUNT_LATENCY}-${label}`,
        unmountResult.duration,
        'ms',
        { success: unmountResult.success, iteration: iter }
      );

      // --- Total lifecycle ---
      const totalDuration = performance.now() - totalStart;
      const totalSuccess = mountResult.success && unmountResult.success;
      ctx.collector.record(
        `${METRICS.BUCKET_TOTAL_LATENCY}-${label}`,
        totalDuration,
        'ms',
        { success: totalSuccess, iteration: iter }
      );

      console.log(
        `    [${label}] ${iterLabel} total=${totalDuration.toFixed(0)}ms ` +
          `mount=${mountResult.duration.toFixed(0)}ms unmount=${unmountResult.duration.toFixed(0)}ms`
      );
    }

    // Cleanup R2 objects created during test
    for (const key of mp.cleanupKeys) {
      await ctx.manager.bucketDelete(sandbox, key);
    }
    mp.cleanupKeys.length = 0;
  }

  function printStats(label: string): void {
    const mountStats = ctx.collector.getStats(
      `${METRICS.BUCKET_MOUNT_LATENCY}-${label}`
    );
    const unmountStats = ctx.collector.getStats(
      `${METRICS.BUCKET_UNMOUNT_LATENCY}-${label}`
    );
    const totalStats = ctx.collector.getStats(
      `${METRICS.BUCKET_TOTAL_LATENCY}-${label}`
    );
    const rtStats = ctx.collector.getStats(
      `${METRICS.BUCKET_ROUNDTRIP_LATENCY}-${label}`
    );

    if (mountStats) {
      console.log(
        `    Mount    p50=${mountStats.p50.toFixed(0)}ms  p95=${mountStats.p95.toFixed(0)}ms`
      );
    }
    if (unmountStats) {
      console.log(
        `    Unmount  p50=${unmountStats.p50.toFixed(0)}ms  p95=${unmountStats.p95.toFixed(0)}ms`
      );
    }
    if (rtStats) {
      console.log(
        `    RT(1kb)  p50=${rtStats.p50.toFixed(0)}ms  p95=${rtStats.p95.toFixed(0)}ms`
      );
    }
    if (totalStats) {
      console.log(
        `    Total    p50=${totalStats.p50.toFixed(0)}ms  p95=${totalStats.p95.toFixed(0)}ms`
      );
    }

    for (const { label: sizeLabel } of FILE_SIZES) {
      const ws = ctx.collector.getStats(
        `${METRICS.BUCKET_WRITE_LATENCY}-${label}-${sizeLabel}`
      );
      const rs = ctx.collector.getStats(
        `${METRICS.BUCKET_READ_LATENCY}-${label}-${sizeLabel}`
      );
      if (ws || rs) {
        const wStr = ws
          ? `write p50=${ws.p50.toFixed(0)}ms p95=${ws.p95.toFixed(0)}ms`
          : '';
        const rStr = rs
          ? `read p50=${rs.p50.toFixed(0)}ms p95=${rs.p95.toFixed(0)}ms`
          : '';
        console.log(`    ${sizeLabel}: ${wStr}  ${rStr}`);
      }
    }
  }

  describe('FUSE (s3fs)', () => {
    const fusePath = getFuseMountPath();

    if (!fusePath) {
      test.skip('Skipping FUSE tests — missing R2 credentials', () => {});
      return;
    }

    test('should measure FUSE mount lifecycle latency', async () => {
      console.log(`\n  FUSE Mount Lifecycle (${ITERATIONS} iterations):`);
      await runMountLifecycle(fusePath);
      printStats('fuse');

      const mountRate = ctx.collector.getSuccessRate(
        `${METRICS.BUCKET_MOUNT_LATENCY}-fuse`
      );
      expect(mountRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    }, 600_000);
  });

  describe('Local Sync (R2 binding)', () => {
    const localPath = getLocalSyncMountPath();

    test('should measure local-sync mount lifecycle latency', async () => {
      console.log(`\n  Local-Sync Mount Lifecycle (${ITERATIONS} iterations):`);
      await runMountLifecycle(localPath);
      printStats('local-sync');

      const mountRate = ctx.collector.getSuccessRate(
        `${METRICS.BUCKET_MOUNT_LATENCY}-local-sync`
      );
      expect(mountRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    }, 600_000);
  });

  test('should compare mount path latencies', () => {
    console.log('\n  === Comparison ===');

    const paths = ['fuse', 'local-sync'];
    for (const label of paths) {
      const mountStats = ctx.collector.getStats(
        `${METRICS.BUCKET_MOUNT_LATENCY}-${label}`
      );
      const unmountStats = ctx.collector.getStats(
        `${METRICS.BUCKET_UNMOUNT_LATENCY}-${label}`
      );
      const totalStats = ctx.collector.getStats(
        `${METRICS.BUCKET_TOTAL_LATENCY}-${label}`
      );

      if (!mountStats) {
        console.log(`  ${label}: no data (skipped or failed)`);
        continue;
      }

      console.log(
        `  ${label}: mount p50=${mountStats.p50.toFixed(0)}ms` +
          (unmountStats
            ? ` unmount p50=${unmountStats.p50.toFixed(0)}ms`
            : '') +
          (totalStats ? ` total p50=${totalStats.p50.toFixed(0)}ms` : '')
      );
    }

    // At least one path must have data
    const fuseMount = ctx.collector.getStats(
      `${METRICS.BUCKET_MOUNT_LATENCY}-fuse`
    );
    const localMount = ctx.collector.getStats(
      `${METRICS.BUCKET_MOUNT_LATENCY}-local-sync`
    );
    expect(fuseMount || localMount).not.toBeNull();
  });
});
