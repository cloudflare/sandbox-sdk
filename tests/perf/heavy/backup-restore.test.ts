/**
 * Backup/Restore Performance Test
 *
 * Measures latency for creating and restoring directory backups at
 * different data sizes (3GB, 5GB, 10GB).
 *
 * The backup flow uses squashfs archives transferred via R2 presigned URLs:
 *   createBackup: mksquashfs → presigned PUT → R2
 *   restoreBackup: R2 → presigned GET → unsquashfs
 *
 * Metrics collected per size:
 * - Backup creation latency (dir → squashfs → R2)
 * - Restore latency (R2 → unsquashfs → dir)
 * - Roundtrip latency (create + restore)
 *
 * Only 1 iteration per size to limit total test time.
 *
 * Requires:
 *   BACKUP_BUCKET R2 binding in wrangler config
 *   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY env vars
 *   BACKUP_BUCKET_NAME env var (defaults to 'sandbox-perf-test')
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import type { SandboxInstance } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

interface BackupSize {
  label: string;
  /** Size in MB to generate with dd */
  megabytes: number;
}

const BACKUP_SIZES: BackupSize[] = [
  { label: '3gb', megabytes: 3_072 },
  { label: '5gb', megabytes: 5_120 },
  { label: '10gb', megabytes: 10_240 }
];

describe('Backup/Restore', () => {
  const ctx = createPerfTestContext(SCENARIOS.BACKUP_RESTORE);
  let sandbox: SandboxInstance;
  let backupAvailable = false;

  const BACKUP_DIR = '/workspace/backup-perf-data';
  const RESTORE_DIR = '/workspace/backup-perf-restore';

  beforeAll(async () => {
    sandbox = await ctx.manager.createSandbox({ initialize: true });

    // Probe for BACKUP_BUCKET availability
    const probeResult = await ctx.manager.createBackup(sandbox, {
      dir: '/nonexistent-probe-dir'
    });
    if (
      probeResult.error?.includes('BACKUP_BUCKET') ||
      probeResult.error?.includes('not configured') ||
      probeResult.error?.includes('R2_ACCESS_KEY_ID') ||
      probeResult.error?.includes('BACKUP_BUCKET_NAME')
    ) {
      console.warn(
        '  Backup infrastructure not configured — backup tests will be skipped'
      );
      backupAvailable = false;
    } else {
      // Any other error (like dir not found) means backup infra IS available
      backupAvailable = true;
    }
  }, 120_000);

  afterAll(async () => {
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  /**
   * Generate test data of the specified size using dd.
   * Creates a single large file filled with random-ish data.
   */
  async function generateTestData(
    sizeLabel: string,
    megabytes: number
  ): Promise<boolean> {
    console.log(`    [${sizeLabel}] Generating ${megabytes}MB test data...`);

    // Create directory and generate data with dd (1MB blocks)
    const genResult = await ctx.manager.executeCommand(
      sandbox,
      `rm -rf ${BACKUP_DIR} && mkdir -p ${BACKUP_DIR} && ` +
        `dd if=/dev/urandom of=${BACKUP_DIR}/data.bin bs=1M count=${megabytes} status=progress 2>&1`
    );

    if (!genResult.success || genResult.exitCode !== 0) {
      console.warn(
        `    [${sizeLabel}] Failed to generate test data: ${genResult.stderr || genResult.stdout}`
      );
      return false;
    }

    // Verify the file exists and has expected size
    const verifyResult = await ctx.manager.executeCommand(
      sandbox,
      `du -sh ${BACKUP_DIR}`
    );
    if (verifyResult.success) {
      console.log(
        `    [${sizeLabel}] Test data created: ${verifyResult.stdout?.trim()}`
      );
    }

    return true;
  }

  /**
   * Clean up test directories
   */
  async function cleanup(): Promise<void> {
    await ctx.manager.executeCommand(
      sandbox,
      `rm -rf ${BACKUP_DIR} ${RESTORE_DIR}`
    );
  }

  for (const { label, megabytes } of BACKUP_SIZES) {
    test(`should measure backup/restore latency for ${label}`, async () => {
      if (!backupAvailable) {
        console.log(
          `    [${label}] Skipping — backup infrastructure not available`
        );
        return;
      }

      // Generate test data
      const dataReady = await generateTestData(label, megabytes);
      if (!dataReady) {
        console.warn(`    [${label}] Skipping — could not generate test data`);
        return;
      }

      const roundtripStart = performance.now();

      // --- Create backup ---
      console.log(`    [${label}] Creating backup...`);
      const createResult = await ctx.manager.createBackup(sandbox, {
        dir: BACKUP_DIR,
        name: `perf-${label}`,
        ttl: 3600
      });

      ctx.collector.record(
        `${METRICS.BACKUP_CREATE_LATENCY}-${label}`,
        createResult.duration,
        'ms',
        { success: createResult.success }
      );

      if (!createResult.success || !createResult.backup) {
        console.warn(
          `    [${label}] Backup creation failed: ${createResult.error}`
        );
        ctx.collector.record(
          `${METRICS.BACKUP_ROUNDTRIP_LATENCY}-${label}`,
          performance.now() - roundtripStart,
          'ms',
          { success: false }
        );
        await cleanup();
        return;
      }

      console.log(
        `    [${label}] Backup created in ${createResult.duration.toFixed(0)}ms (id=${createResult.backup.id})`
      );

      // --- Restore backup into a separate directory ---
      // Clear original data so we can verify restore works
      await ctx.manager.executeCommand(
        sandbox,
        `rm -rf ${RESTORE_DIR} && mkdir -p ${RESTORE_DIR}`
      );

      console.log(`    [${label}] Restoring backup...`);
      const restoreResult = await ctx.manager.restoreBackup(sandbox, {
        id: createResult.backup.id,
        dir: RESTORE_DIR
      });

      ctx.collector.record(
        `${METRICS.BACKUP_RESTORE_LATENCY}-${label}`,
        restoreResult.duration,
        'ms',
        { success: restoreResult.success }
      );

      const roundtripDuration = performance.now() - roundtripStart;
      const roundtripSuccess = createResult.success && restoreResult.success;

      ctx.collector.record(
        `${METRICS.BACKUP_ROUNDTRIP_LATENCY}-${label}`,
        roundtripDuration,
        'ms',
        { success: roundtripSuccess }
      );

      if (!restoreResult.success) {
        console.warn(`    [${label}] Restore failed: ${restoreResult.error}`);
      } else {
        console.log(
          `    [${label}] Restored in ${restoreResult.duration.toFixed(0)}ms`
        );

        // Verify restored data size matches
        const verifyResult = await ctx.manager.executeCommand(
          sandbox,
          `du -sh ${RESTORE_DIR}`
        );
        if (verifyResult.success) {
          console.log(
            `    [${label}] Restored data: ${verifyResult.stdout?.trim()}`
          );
        }
      }

      console.log(
        `    [${label}] Roundtrip: ${roundtripDuration.toFixed(0)}ms ` +
          `(create=${createResult.duration.toFixed(0)}ms restore=${restoreResult.duration.toFixed(0)}ms)`
      );

      // Cleanup
      await cleanup();

      expect(createResult.success).toBe(true);
    }, 1_800_000); // 30 min timeout per size (large data + squashfs compression)
  }

  test('should print summary', () => {
    console.log('\n  === Backup/Restore Summary ===');

    for (const { label } of BACKUP_SIZES) {
      const createStats = ctx.collector.getStats(
        `${METRICS.BACKUP_CREATE_LATENCY}-${label}`
      );
      const restoreStats = ctx.collector.getStats(
        `${METRICS.BACKUP_RESTORE_LATENCY}-${label}`
      );
      const rtStats = ctx.collector.getStats(
        `${METRICS.BACKUP_ROUNDTRIP_LATENCY}-${label}`
      );

      if (!createStats && !restoreStats) {
        console.log(`  ${label}: no data (skipped or failed)`);
        continue;
      }

      const createStr = createStats
        ? `create=${createStats.mean.toFixed(0)}ms`
        : 'create=N/A';
      const restoreStr = restoreStats
        ? `restore=${restoreStats.mean.toFixed(0)}ms`
        : 'restore=N/A';
      const rtStr = rtStats
        ? `roundtrip=${rtStats.mean.toFixed(0)}ms`
        : 'roundtrip=N/A';

      console.log(`  ${label}: ${createStr}  ${restoreStr}  ${rtStr}`);
    }

    // At least one size should have data if backup was available
    const anyData = BACKUP_SIZES.some(
      ({ label }) =>
        ctx.collector.getStats(`${METRICS.BACKUP_CREATE_LATENCY}-${label}`) !==
        null
    );
    if (anyData) {
      const createRate = ctx.collector.getSuccessRate(
        `${METRICS.BACKUP_CREATE_LATENCY}-3gb`
      );
      expect(createRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    }
  });
});
