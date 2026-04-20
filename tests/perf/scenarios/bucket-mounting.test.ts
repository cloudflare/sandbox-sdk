/**
 * Bucket Mounting Performance Test
 *
 * Measures mount/unmount latency and file I/O throughput through an S3-mounted bucket:
 * - Mount and unmount latency
 * - Write files of varying sizes to the mount, then read them back
 * - Verify written files appear in R2 via binding (mount → R2 propagation)
 * - Full mount→write→read→unmount cycle time
 *
 * Requires FUSE device access and R2 credentials (CI only).
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

  const TEST_BUCKET = 'sandbox-e2e-test';
  const MOUNT_PATH = '/mnt/perf-bucket';
  const FILE_PREFIX = 'perf-bucket';

  const ITERATIONS = 3;

  const FILE_SIZES: Array<{ label: string; bytes: number }> = [
    { label: '1kb', bytes: 1_024 },
    { label: '10kb', bytes: 10_240 },
    { label: '100kb', bytes: 102_400 }
  ];

  const FILE_COUNTS = [1, 5, 10];

  let bucketAvailable = false;
  let r2Keys: string[] = [];

  /**
   * Generate pseudorandom content that does not compress well.
   * Uses a simple LCG to produce printable ASCII without needing crypto.
   */
  function generatePseudorandomContent(bytes: number): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let seed = 0xdeadbeef;
    const result: string[] = [];
    for (let i = 0; i < bytes; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      result.push(chars[(seed >>> 16) & 63]);
    }
    return result.join('');
  }

  beforeAll(async () => {
    const deployedUrl = process.env.PERF_DEPLOYED_WORKER_URL;
    if (!deployedUrl) {
      console.warn(
        '[BucketMounting] PERF_DEPLOYED_WORKER_URL not set — tests will be skipped'
      );
      return;
    }

    manager = new PerfSandboxManager({ workerUrl: deployedUrl });
    sandbox = await manager.createSandbox({ initialize: true });

    // Probe bucket mounting availability (requires FUSE + R2 credentials)
    const probeResult = await manager.mountBucket(
      sandbox,
      TEST_BUCKET,
      '/mnt/perf-probe',
      {
        endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      }
    );

    if (probeResult.success) {
      bucketAvailable = true;
      await manager.unmountBucket(sandbox, '/mnt/perf-probe');
    } else {
      console.warn(
        `[BucketMounting] Bucket mounting not available: ${probeResult.error}`
      );
      console.warn(
        '[BucketMounting] Tests will be skipped. Requires FUSE + R2 credentials.'
      );
    }
  }, 120000);

  afterAll(async () => {
    if (manager) {
      // Clean up any leftover R2 objects
      for (const key of r2Keys) {
        await manager.deleteBucketObject(sandbox, key);
      }
      await manager.destroyAll();
    }
    registerPerfScenario(ctx);
  });

  test('should measure mount and unmount latency', async () => {
    if (!bucketAvailable) return;

    console.log(`\n  Mount/unmount latency (${ITERATIONS} iterations):`);

    for (let i = 0; i < ITERATIONS; i++) {
      const mountPath = `${MOUNT_PATH}-lat-${i}`;

      const mountResult = await manager.mountBucket(
        sandbox,
        TEST_BUCKET,
        mountPath,
        {
          endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
        }
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

      if (mountResult.success) {
        const unmountResult = await manager.unmountBucket(sandbox, mountPath);
        ctx.collector.record(
          METRICS.BUCKET_UNMOUNT_LATENCY,
          unmountResult.duration,
          'ms',
          { success: unmountResult.success, iteration: i }
        );
      }
    }

    const mountStats = ctx.collector.getStats(METRICS.BUCKET_MOUNT_LATENCY);
    const unmountStats = ctx.collector.getStats(METRICS.BUCKET_UNMOUNT_LATENCY);
    if (mountStats) {
      console.log(
        `    Mount  p50=${mountStats.p50.toFixed(0)}ms  p95=${mountStats.p95.toFixed(0)}ms`
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

  test('should measure write latency through mounted bucket by file size', async () => {
    if (!bucketAvailable) return;

    console.log(
      `\n  Bucket write latency by file size (${ITERATIONS} iterations):`
    );

    const mountPath = `${MOUNT_PATH}-write`;
    const mountResult = await manager.mountBucket(
      sandbox,
      TEST_BUCKET,
      mountPath,
      {
        endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      }
    );
    expect(mountResult.success).toBe(true);

    try {
      for (const { label, bytes } of FILE_SIZES) {
        const content = generatePseudorandomContent(bytes);

        for (let i = 0; i < ITERATIONS; i++) {
          const filename = `${FILE_PREFIX}-w-${label}-${i}.txt`;
          const filePath = `${mountPath}/${filename}`;
          r2Keys.push(filename);

          const writeResult = await manager.executeCommand(
            sandbox,
            `cat > ${filePath} << 'PERFEOF'\n${content}\nPERFEOF`
          );
          ctx.collector.record(
            `${METRICS.BUCKET_WRITE_LATENCY}-${label}`,
            writeResult.duration,
            'ms',
            { success: writeResult.success, iteration: i }
          );
        }

        const writeStats = ctx.collector.getStats(
          `${METRICS.BUCKET_WRITE_LATENCY}-${label}`
        );
        if (writeStats) {
          console.log(
            `    ${label}: p50=${writeStats.p50.toFixed(0)}ms  p95=${writeStats.p95.toFixed(0)}ms`
          );
        }
      }
    } finally {
      await manager.unmountBucket(sandbox, mountPath);
    }

    const smallWriteRate = ctx.collector.getSuccessRate(
      `${METRICS.BUCKET_WRITE_LATENCY}-1kb`
    );
    expect(smallWriteRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);

  test('should measure read latency through mounted bucket by file size', async () => {
    if (!bucketAvailable) return;

    console.log(
      `\n  Bucket read latency by file size (${ITERATIONS} iterations):`
    );

    const mountPath = `${MOUNT_PATH}-read`;
    const mountResult = await manager.mountBucket(
      sandbox,
      TEST_BUCKET,
      mountPath,
      {
        endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      }
    );
    expect(mountResult.success).toBe(true);

    try {
      for (const { label } of FILE_SIZES) {
        for (let i = 0; i < ITERATIONS; i++) {
          const filename = `${FILE_PREFIX}-w-${label}-${i}.txt`;
          const filePath = `${mountPath}/${filename}`;

          const readResult = await manager.executeCommand(
            sandbox,
            `cat ${filePath} > /dev/null`
          );
          ctx.collector.record(
            `${METRICS.BUCKET_READ_LATENCY}-${label}`,
            readResult.duration,
            'ms',
            { success: readResult.success, iteration: i }
          );
        }

        const readStats = ctx.collector.getStats(
          `${METRICS.BUCKET_READ_LATENCY}-${label}`
        );
        if (readStats) {
          console.log(
            `    ${label}: p50=${readStats.p50.toFixed(0)}ms  p95=${readStats.p95.toFixed(0)}ms`
          );
        }
      }
    } finally {
      await manager.unmountBucket(sandbox, mountPath);
    }

    const smallReadRate = ctx.collector.getSuccessRate(
      `${METRICS.BUCKET_READ_LATENCY}-1kb`
    );
    expect(smallReadRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);

  test('should measure mount→R2 propagation (write via mount, verify via R2 binding)', async () => {
    if (!bucketAvailable) return;

    console.log(`\n  Mount→R2 propagation latency (${ITERATIONS} iterations):`);

    const mountPath = `${MOUNT_PATH}-r2verify`;
    const mountResult = await manager.mountBucket(
      sandbox,
      TEST_BUCKET,
      mountPath,
      {
        endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      }
    );
    expect(mountResult.success).toBe(true);

    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const key = `${FILE_PREFIX}-r2v-${Date.now()}-${i}.txt`;
        const content = generatePseudorandomContent(1024);
        r2Keys.push(key);

        await manager.executeCommand(
          sandbox,
          `echo '${content}' > ${mountPath}/${key}`
        );

        // Allow s3fs cache to flush
        await new Promise((r) => setTimeout(r, 2000));

        const verifyResult = await manager.getBucketObject(sandbox, key);
        ctx.collector.record(
          METRICS.BUCKET_R2_VERIFY_LATENCY,
          verifyResult.duration,
          'ms',
          { success: verifyResult.success, iteration: i }
        );
      }
    } finally {
      await manager.unmountBucket(sandbox, mountPath);
    }

    const verifyStats = ctx.collector.getStats(
      METRICS.BUCKET_R2_VERIFY_LATENCY
    );
    if (verifyStats) {
      console.log(
        `    p50=${verifyStats.p50.toFixed(0)}ms  p95=${verifyStats.p95.toFixed(0)}ms`
      );
    }
  }, 600000);

  test('should measure multi-file write throughput at varying file counts', async () => {
    if (!bucketAvailable) return;

    console.log('\n  Multi-file write throughput:');

    for (const count of FILE_COUNTS) {
      const mountPath = `${MOUNT_PATH}-multi-${count}`;
      const mountResult = await manager.mountBucket(
        sandbox,
        TEST_BUCKET,
        mountPath,
        {
          endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
        }
      );
      expect(mountResult.success).toBe(true);

      try {
        const content = generatePseudorandomContent(10_240);
        const start = performance.now();
        let allSuccess = true;

        for (let i = 0; i < count; i++) {
          const key = `${FILE_PREFIX}-multi-${count}-${i}.txt`;
          r2Keys.push(key);
          const result = await manager.executeCommand(
            sandbox,
            `cat > ${mountPath}/${key} << 'PERFEOF'\n${content}\nPERFEOF`
          );
          if (!result.success) allSuccess = false;
        }

        const totalDuration = performance.now() - start;
        ctx.collector.record(
          `${METRICS.BUCKET_WRITE_LATENCY}-${count}files`,
          totalDuration,
          'ms',
          { success: allSuccess, fileCount: count }
        );

        console.log(
          `    ${count} files (10kb each): ${totalDuration.toFixed(0)}ms total` +
            ` (${(totalDuration / count).toFixed(0)}ms/file)`
        );
      } finally {
        await manager.unmountBucket(sandbox, mountPath);
      }
    }
  }, 600000);
});
