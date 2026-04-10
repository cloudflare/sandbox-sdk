/**
 * Backup & Restore Performance Test
 *
 * Measures create/restore latency for both local (R2 binding, no FUSE) and
 * production (presigned URL + FUSE overlay) backup flows.
 *
 * Requires CI environment (TEST_WORKER_URL) with BACKUP_BUCKET R2 binding.
 * Production flow additionally requires R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import { getWorkerUrl } from '../helpers/get-worker-url';
import type { SandboxInstance } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Backup & Restore Performance', () => {
  let _workerUrl: string | null = null;
  try {
    _workerUrl = getWorkerUrl();
  } catch {}

  if (!_workerUrl) {
    test.skip('Skipping — requires a running perf environment (global-setup must have run)', () => {});
    return;
  }

  const ctx = createPerfTestContext(SCENARIOS.BACKUP_RESTORE);
  let sandbox: SandboxInstance;
  let backupBucketAvailable = false;

  const ITERATIONS = 5;
  const TEST_BASE_DIR = `/workspace/perf-backup-${Date.now()}`;

  beforeAll(async () => {
    sandbox = await ctx.manager.createSandbox({ initialize: true });

    await ctx.manager.executeCommand(sandbox, `mkdir -p ${TEST_BASE_DIR}`);

    // Probe for BACKUP_BUCKET availability using localBucket: true so we only
    // fail on a missing R2 binding, not on absent presigned-URL credentials.
    const probeResponse = await fetch(`${ctx.workerUrl}/api/backup/create`, {
      method: 'POST',
      headers: sandbox.headers,
      body: JSON.stringify({ dir: '/nonexistent-probe-dir', localBucket: true })
    });
    const probeText = await probeResponse.text();
    if (probeText.includes('BACKUP_BUCKET')) {
      console.warn(
        '[PerfBackup] BACKUP_BUCKET not configured — backup tests will be skipped'
      );
    } else {
      backupBucketAvailable = true;
    }
  }, 120000);

  afterAll(async () => {
    if (sandbox) {
      await ctx.manager.executeCommand(sandbox, `rm -rf ${TEST_BASE_DIR}`);
    }
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test('backup and restore — local flow (R2 binding, no FUSE)', async () => {
    if (!backupBucketAvailable) return;

    console.log(`\nBackup/restore local: ${ITERATIONS} iterations`);

    for (let i = 0; i < ITERATIONS; i++) {
      const iterDir = `${TEST_BASE_DIR}/local-${i}`;

      // Create a ~10 KB test file inside the iteration directory
      await ctx.manager.executeCommand(
        sandbox,
        `mkdir -p ${iterDir} && dd if=/dev/zero bs=10240 count=1 2>/dev/null | tr '\\0' 'x' > ${iterDir}/data.txt`
      );

      // Measure create
      const roundtripStart = performance.now();
      const createResult = await ctx.manager.createBackup(sandbox, {
        dir: iterDir,
        localBucket: true
      });
      ctx.collector.record(
        `${METRICS.BACKUP_CREATE_LATENCY}-local`,
        createResult.duration,
        'ms',
        { success: createResult.success, iteration: i }
      );

      if (!createResult.success || !createResult.id) {
        console.warn(
          `  [local iter ${i}] Create failed: ${createResult.error}`
        );
        continue;
      }

      // Wipe directory to make restore meaningful
      await ctx.manager.executeCommand(sandbox, `rm -rf ${iterDir}/*`);

      // Measure restore
      const restoreResult = await ctx.manager.restoreBackup(sandbox, {
        id: createResult.id,
        dir: iterDir,
        localBucket: true
      });
      const roundtrip = performance.now() - roundtripStart;

      ctx.collector.record(
        `${METRICS.BACKUP_RESTORE_LATENCY}-local`,
        restoreResult.duration,
        'ms',
        { success: restoreResult.success, iteration: i }
      );
      ctx.collector.record(
        `${METRICS.BACKUP_ROUNDTRIP_LATENCY}-local`,
        roundtrip,
        'ms',
        {
          success: createResult.success && restoreResult.success,
          iteration: i
        }
      );

      await ctx.manager.executeCommand(sandbox, `rm -rf ${iterDir}`);
    }

    const createStats = ctx.collector.getStats(
      `${METRICS.BACKUP_CREATE_LATENCY}-local`
    );
    const restoreStats = ctx.collector.getStats(
      `${METRICS.BACKUP_RESTORE_LATENCY}-local`
    );
    if (createStats) {
      console.log(
        `  Create  p50=${createStats.p50.toFixed(0)}ms  p95=${createStats.p95.toFixed(0)}ms`
      );
    }
    if (restoreStats) {
      console.log(
        `  Restore p50=${restoreStats.p50.toFixed(0)}ms  p95=${restoreStats.p95.toFixed(0)}ms`
      );
    }

    const createRate = ctx.collector.getSuccessRate(
      `${METRICS.BACKUP_CREATE_LATENCY}-local`
    );
    expect(createRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);

  test('backup and restore — production flow (presigned URL + FUSE overlay)', async () => {
    if (!backupBucketAvailable) return;
    if (!process.env.R2_ACCESS_KEY_ID) {
      console.log(
        '  Skipping — R2_ACCESS_KEY_ID not set (production backup requires presigned URL credentials)'
      );
      return;
    }

    console.log(`\nBackup/restore production: ${ITERATIONS} iterations`);

    for (let i = 0; i < ITERATIONS; i++) {
      const iterDir = `${TEST_BASE_DIR}/prod-${i}`;

      await ctx.manager.executeCommand(
        sandbox,
        `mkdir -p ${iterDir} && dd if=/dev/zero bs=10240 count=1 2>/dev/null | tr '\\0' 'x' > ${iterDir}/data.txt`
      );

      const roundtripStart = performance.now();
      const createResult = await ctx.manager.createBackup(sandbox, {
        dir: iterDir
      });
      ctx.collector.record(
        `${METRICS.BACKUP_CREATE_LATENCY}-prod`,
        createResult.duration,
        'ms',
        { success: createResult.success, iteration: i }
      );

      if (!createResult.success || !createResult.id) {
        console.warn(`  [prod iter ${i}] Create failed: ${createResult.error}`);
        continue;
      }

      // Unmount any FUSE overlay and wipe directory contents
      await ctx.manager.executeCommand(
        sandbox,
        `fusermount3 -u ${iterDir} 2>/dev/null || true; rm -rf ${iterDir}/*`
      );

      const restoreResult = await ctx.manager.restoreBackup(sandbox, {
        id: createResult.id,
        dir: iterDir
      });
      const roundtrip = performance.now() - roundtripStart;

      ctx.collector.record(
        `${METRICS.BACKUP_RESTORE_LATENCY}-prod`,
        restoreResult.duration,
        'ms',
        { success: restoreResult.success, iteration: i }
      );
      ctx.collector.record(
        `${METRICS.BACKUP_ROUNDTRIP_LATENCY}-prod`,
        roundtrip,
        'ms',
        {
          success: createResult.success && restoreResult.success,
          iteration: i
        }
      );

      // Cleanup: unmount FUSE overlay before removing directory
      await ctx.manager.executeCommand(
        sandbox,
        `fusermount3 -u ${iterDir} 2>/dev/null || true; rm -rf ${iterDir}`
      );
    }

    const createStats = ctx.collector.getStats(
      `${METRICS.BACKUP_CREATE_LATENCY}-prod`
    );
    const restoreStats = ctx.collector.getStats(
      `${METRICS.BACKUP_RESTORE_LATENCY}-prod`
    );
    if (createStats) {
      console.log(
        `  Create  p50=${createStats.p50.toFixed(0)}ms  p95=${createStats.p95.toFixed(0)}ms`
      );
    }
    if (restoreStats) {
      console.log(
        `  Restore p50=${restoreStats.p50.toFixed(0)}ms  p95=${restoreStats.p95.toFixed(0)}ms`
      );
    }

    const createRate = ctx.collector.getSuccessRate(
      `${METRICS.BACKUP_CREATE_LATENCY}-prod`
    );
    expect(createRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);
});
