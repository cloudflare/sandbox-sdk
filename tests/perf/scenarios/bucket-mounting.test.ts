/**
 * Bucket Mounting Performance Test
 *
 * Measures S3-compatible bucket mount/unmount latencies and I/O through
 * the mounted filesystem:
 * - Mount latency (s3fs FUSE mount)
 * - Write latency through mount (file appears in R2)
 * - Read latency through mount (file from R2 visible on disk)
 * - Write → read roundtrip through mount
 * - Unmount latency
 *
 * Requires:
 *   CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   TEST_BUCKET R2 binding on the deployed test worker
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import {
  PerfSandboxManager,
  type SandboxInstance
} from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Bucket Mounting', () => {
  const ctx = createPerfTestContext(SCENARIOS.BUCKET_MOUNTING);
  let sandbox: SandboxInstance;
  let manager: PerfSandboxManager;
  let shouldRun = false;

  const BUCKET_NAME = 'sandbox-e2e-test';
  const MOUNT_ITERATIONS = 5;
  const IO_ITERATIONS = 10;

  function mountOptions() {
    return {
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      }
    };
  }

  beforeAll(async () => {
    const deployedUrl = process.env.PERF_DEPLOYED_WORKER_URL;
    if (!deployedUrl) {
      console.warn(
        'PERF_DEPLOYED_WORKER_URL not set — bucket mounting perf tests will be skipped'
      );
      return;
    }

    const required = [
      'CLOUDFLARE_ACCOUNT_ID',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY'
    ];
    const missing = required.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      console.warn(
        `Missing env vars for bucket mounting: ${missing.join(', ')} — tests will be skipped`
      );
      return;
    }

    manager = new PerfSandboxManager({ workerUrl: deployedUrl });
    sandbox = await manager.createSandbox({ initialize: true });
    shouldRun = true;
  }, 120000);

  afterAll(async () => {
    if (manager) await manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test('should measure mount and unmount latency', async () => {
    if (!shouldRun) {
      console.log('  Skipped — deployed worker / credentials not available');
      return;
    }

    console.log(`\n  Mount/unmount latency (${MOUNT_ITERATIONS} iterations):`);

    for (let i = 0; i < MOUNT_ITERATIONS; i++) {
      const mountPath = `/mnt/perf-mount-${i}`;

      // Measure mount
      const mountResult = await manager.mountBucket(
        sandbox,
        BUCKET_NAME,
        mountPath,
        mountOptions()
      );
      ctx.collector.record(
        METRICS.BUCKET_MOUNT_LATENCY,
        mountResult.duration,
        'ms',
        {
          success: mountResult.success,
          iteration: i
        }
      );

      if (!mountResult.success) {
        console.warn(`    Mount ${i} failed: ${mountResult.error}`);
        continue;
      }

      // Measure unmount
      const unmountResult = await manager.unmountBucket(sandbox, mountPath);
      ctx.collector.record(
        METRICS.BUCKET_UNMOUNT_LATENCY,
        unmountResult.duration,
        'ms',
        { success: unmountResult.success, iteration: i }
      );
    }

    const mountStats = ctx.collector.getStats(METRICS.BUCKET_MOUNT_LATENCY);
    const unmountStats = ctx.collector.getStats(METRICS.BUCKET_UNMOUNT_LATENCY);
    if (mountStats) {
      console.log(
        `    Mount   p50=${mountStats.p50.toFixed(0)}ms  p95=${mountStats.p95.toFixed(0)}ms`
      );
    }
    if (unmountStats) {
      console.log(
        `    Unmount p50=${unmountStats.p50.toFixed(0)}ms  p95=${unmountStats.p95.toFixed(0)}ms`
      );
    }

    const mountRate = ctx.collector.getSuccessRate(
      METRICS.BUCKET_MOUNT_LATENCY
    );
    expect(mountRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);

  test('should measure write latency through mounted bucket', async () => {
    if (!shouldRun) {
      console.log('  Skipped — deployed worker / credentials not available');
      return;
    }

    console.log(`\n  Write through mount (${IO_ITERATIONS} iterations):`);

    const mountPath = '/mnt/perf-write-test';
    const testKeys: string[] = [];

    // Mount once for all write iterations
    const mountResult = await manager.mountBucket(
      sandbox,
      BUCKET_NAME,
      mountPath,
      mountOptions()
    );
    if (!mountResult.success) {
      console.warn(`  Mount failed: ${mountResult.error} — skipping`);
      return;
    }

    try {
      for (let i = 0; i < IO_ITERATIONS; i++) {
        const key = `perf-write-${Date.now()}-${i}.txt`;
        const content = `perf write test iteration ${i} - ${Date.now()}`;
        testKeys.push(key);

        const start = performance.now();
        const writeResult = await manager.executeCommand(
          sandbox,
          `echo "${content}" > ${mountPath}/${key}`
        );
        const duration = performance.now() - start;

        ctx.collector.record(METRICS.BUCKET_WRITE_LATENCY, duration, 'ms', {
          success: writeResult.success,
          iteration: i
        });
      }

      const stats = ctx.collector.getStats(METRICS.BUCKET_WRITE_LATENCY);
      if (stats) {
        console.log(
          `    p50=${stats.p50.toFixed(0)}ms  p95=${stats.p95.toFixed(0)}ms`
        );
      }

      const writeRate = ctx.collector.getSuccessRate(
        METRICS.BUCKET_WRITE_LATENCY
      );
      expect(writeRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    } finally {
      // Unmount and cleanup test files from R2
      await manager.unmountBucket(sandbox, mountPath);
      for (const key of testKeys) {
        await manager.deleteBucketObject(sandbox, key);
      }
    }
  }, 600000);

  test('should measure read latency through mounted bucket', async () => {
    if (!shouldRun) {
      console.log('  Skipped — deployed worker / credentials not available');
      return;
    }

    console.log(`\n  Read through mount (${IO_ITERATIONS} iterations):`);

    const mountPath = '/mnt/perf-read-test';
    const testKeys: string[] = [];

    // Seed R2 with test files before mounting
    for (let i = 0; i < IO_ITERATIONS; i++) {
      const key = `perf-read-${Date.now()}-${i}.txt`;
      const content = `perf read test iteration ${i}`;
      testKeys.push(key);
      await manager.putBucketObject(sandbox, key, content);
    }

    // Mount
    const mountResult = await manager.mountBucket(
      sandbox,
      BUCKET_NAME,
      mountPath,
      mountOptions()
    );
    if (!mountResult.success) {
      console.warn(`  Mount failed: ${mountResult.error} — skipping`);
      for (const key of testKeys) {
        await manager.deleteBucketObject(sandbox, key);
      }
      return;
    }

    try {
      for (let i = 0; i < IO_ITERATIONS; i++) {
        const start = performance.now();
        const readResult = await manager.executeCommand(
          sandbox,
          `cat ${mountPath}/${testKeys[i]}`
        );
        const duration = performance.now() - start;

        ctx.collector.record(METRICS.BUCKET_READ_LATENCY, duration, 'ms', {
          success: readResult.success && readResult.exitCode === 0,
          iteration: i
        });
      }

      const stats = ctx.collector.getStats(METRICS.BUCKET_READ_LATENCY);
      if (stats) {
        console.log(
          `    p50=${stats.p50.toFixed(0)}ms  p95=${stats.p95.toFixed(0)}ms`
        );
      }

      const readRate = ctx.collector.getSuccessRate(
        METRICS.BUCKET_READ_LATENCY
      );
      expect(readRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    } finally {
      await manager.unmountBucket(sandbox, mountPath);
      for (const key of testKeys) {
        await manager.deleteBucketObject(sandbox, key);
      }
    }
  }, 600000);

  test('should measure write→read roundtrip latency through mount', async () => {
    if (!shouldRun) {
      console.log('  Skipped — deployed worker / credentials not available');
      return;
    }

    console.log(
      `\n  Roundtrip (write+read) through mount (${IO_ITERATIONS} iterations):`
    );

    const mountPath = '/mnt/perf-roundtrip-test';
    const testKeys: string[] = [];

    const mountResult = await manager.mountBucket(
      sandbox,
      BUCKET_NAME,
      mountPath,
      mountOptions()
    );
    if (!mountResult.success) {
      console.warn(`  Mount failed: ${mountResult.error} — skipping`);
      return;
    }

    try {
      for (let i = 0; i < IO_ITERATIONS; i++) {
        const key = `perf-rt-${Date.now()}-${i}.txt`;
        const content = `roundtrip-${i}-${Date.now()}`;
        testKeys.push(key);

        const start = performance.now();

        // Write
        const writeResult = await manager.executeCommand(
          sandbox,
          `echo "${content}" > ${mountPath}/${key}`
        );

        let roundtripSuccess = false;
        if (writeResult.success) {
          // Read back
          const readResult = await manager.executeCommand(
            sandbox,
            `cat ${mountPath}/${key}`
          );
          roundtripSuccess =
            readResult.success && readResult.stdout.trim() === content;
        }

        const duration = performance.now() - start;

        ctx.collector.record(METRICS.BUCKET_ROUNDTRIP_LATENCY, duration, 'ms', {
          success: roundtripSuccess,
          iteration: i
        });
      }

      const stats = ctx.collector.getStats(METRICS.BUCKET_ROUNDTRIP_LATENCY);
      if (stats) {
        console.log(
          `    p50=${stats.p50.toFixed(0)}ms  p95=${stats.p95.toFixed(0)}ms`
        );
      }

      const rtRate = ctx.collector.getSuccessRate(
        METRICS.BUCKET_ROUNDTRIP_LATENCY
      );
      expect(rtRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    } finally {
      await manager.unmountBucket(sandbox, mountPath);
      for (const key of testKeys) {
        await manager.deleteBucketObject(sandbox, key);
      }
    }
  }, 600000);
});
