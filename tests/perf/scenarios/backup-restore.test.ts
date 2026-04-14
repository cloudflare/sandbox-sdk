/**
 * Backup / Restore Performance Test
 *
 * Measures backup creation and restore latency across varying data sizes:
 * - Generate pseudorandom (incompressible) data in the container
 * - Time backup creation (mksquashfs → R2 upload)
 * - Time restore (R2 download → squashfuse/unsquashfs overlay)
 * - Read and write latency on the restored directory
 *
 * Requires BACKUP_BUCKET R2 binding (CI only).
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from '../helpers/constants';
import type { SandboxInstance } from '../helpers/perf-sandbox-manager';
import {
  createPerfTestContext,
  registerPerfScenario
} from '../helpers/perf-test-fixture';

describe('Backup / Restore', () => {
  const ctx = createPerfTestContext(SCENARIOS.BACKUP_RESTORE);
  let sandbox: SandboxInstance;

  let backupBucketAvailable = false;

  const DATA_SIZES: Array<{ label: string; bytes: number; fileCount: number }> =
    [
      { label: '100mb', bytes: 104_857_600, fileCount: 10 },
      { label: '500mb', bytes: 524_288_000, fileCount: 10 },
      { label: '1gb', bytes: 1_073_741_824, fileCount: 10 }
    ];

  const ITERATIONS = 2;

  beforeAll(async () => {
    sandbox = await ctx.manager.createSandbox({ initialize: true });

    // Probe backup availability by attempting a backup of a tiny directory
    const probeDir = '/tmp/perf-backup-probe';
    await ctx.manager.executeCommand(
      sandbox,
      `mkdir -p ${probeDir} && echo probe > ${probeDir}/probe.txt`
    );
    const probeResult = await ctx.manager.createBackup(sandbox, probeDir, {
      name: 'perf-probe',
      ttl: 60
    });

    if (probeResult.success) {
      backupBucketAvailable = true;
    } else {
      console.warn(
        `[BackupRestore] Backup not available: ${probeResult.error}`
      );
      console.warn(
        '[BackupRestore] Tests will be skipped. Requires BACKUP_BUCKET R2 binding + R2 credentials.'
      );
    }

    await ctx.manager.executeCommand(sandbox, `rm -rf ${probeDir}`);
  }, 120000);

  afterAll(async () => {
    await ctx.manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test('should measure backup→restore→read→write pipeline by data size', async () => {
    if (!backupBucketAvailable) return;

    const IO_SAMPLE_COUNT = 20;

    console.log(
      `\n  Backup→restore→read→write pipeline (${ITERATIONS} iterations per size):`
    );

    for (const { label, bytes, fileCount } of DATA_SIZES) {
      const perFileBytes = Math.floor(bytes / fileCount);
      const perFileMB = Math.max(1, Math.floor(perFileBytes / 1_048_576));
      const totalMB = perFileMB * fileCount;

      for (let i = 0; i < ITERATIONS; i++) {
        const srcDir = `/tmp/perf-backup-${label}-${i}`;
        const restoreDir = `/tmp/perf-restore-${label}-${i}`;

        // ── Generate data ──
        await ctx.manager.executeCommand(
          sandbox,
          `mkdir -p ${srcDir} && for f in $(seq 0 $((${fileCount}-1))); do dd if=/dev/urandom of=${srcDir}/file-$f.bin bs=1M count=${perFileMB} 2>/dev/null; done`
        );

        // ── Create backup (timed) ──
        const backupResult = await ctx.manager.createBackup(sandbox, srcDir, {
          name: `perf-${label}-${i}`,
          ttl: 3600
        });
        ctx.collector.record(
          `${METRICS.BACKUP_CREATE_LATENCY}-${label}`,
          backupResult.duration,
          'ms',
          { success: backupResult.success, iteration: i }
        );

        if (!backupResult.success || !backupResult.id) {
          console.warn(`    ${label}-${i}: backup failed, skipping rest`);
          await ctx.manager.executeCommand(sandbox, `rm -rf ${srcDir}`);
          continue;
        }

        // ── Restore backup (timed) ──
        const restoreResult = await ctx.manager.restoreBackup(
          sandbox,
          backupResult.id,
          restoreDir
        );
        ctx.collector.record(
          `${METRICS.BACKUP_RESTORE_LATENCY}-${label}`,
          restoreResult.duration,
          'ms',
          { success: restoreResult.success, iteration: i }
        );

        if (!restoreResult.success) {
          console.warn(`    ${label}-${i}: restore failed, skipping I/O`);
          await ctx.manager.executeCommand(
            sandbox,
            `fusermount3 -u ${restoreDir} 2>/dev/null || true; rm -rf ${srcDir} ${restoreDir}`
          );
          continue;
        }

        // ── Bulk read all files (timed) ──
        const bulkReadResult = await ctx.manager.executeCommand(
          sandbox,
          `find ${restoreDir} -name '*.bin' -type f | sort | xargs cat > /dev/null`
        );
        ctx.collector.record(
          `${METRICS.BACKUP_BULK_READ_TOTAL}-${label}`,
          bulkReadResult.duration,
          'ms',
          { success: bulkReadResult.success, files: fileCount, iteration: i }
        );
        if (bulkReadResult.success) {
          ctx.collector.record(
            `${METRICS.BACKUP_BULK_READ_THROUGHPUT}-${label}`,
            (totalMB / bulkReadResult.duration) * 1000,
            'MB/s',
            { iteration: i }
          );
        }

        // ── Sample per-file read latency ──
        const sampleStep = Math.max(1, Math.floor(fileCount / IO_SAMPLE_COUNT));
        for (let f = 0; f < fileCount; f += sampleStep) {
          const r = await ctx.manager.executeCommand(
            sandbox,
            `cat ${restoreDir}/file-${f}.bin > /dev/null`
          );
          ctx.collector.record(
            METRICS.BACKUP_RESTORED_READ_LATENCY,
            r.duration,
            'ms',
            { success: r.success, fileIndex: f }
          );
        }

        // ── Bulk write new files through COW layer (timed) ──
        const bulkWriteResult = await ctx.manager.executeCommand(
          sandbox,
          `for f in $(seq 0 $((${fileCount}-1))); do dd if=/dev/urandom of=${restoreDir}/new-$f.bin bs=1M count=${perFileMB} 2>/dev/null; done`
        );
        ctx.collector.record(
          `${METRICS.BACKUP_BULK_WRITE_TOTAL}-${label}`,
          bulkWriteResult.duration,
          'ms',
          { success: bulkWriteResult.success, files: fileCount, iteration: i }
        );
        if (bulkWriteResult.success) {
          ctx.collector.record(
            `${METRICS.BACKUP_BULK_WRITE_THROUGHPUT}-${label}`,
            (totalMB / bulkWriteResult.duration) * 1000,
            'MB/s',
            { iteration: i }
          );
        }

        // ── Sample per-file write latency ──
        for (let f = 0; f < fileCount; f += sampleStep) {
          const w = await ctx.manager.executeCommand(
            sandbox,
            `dd if=/dev/urandom of=${restoreDir}/sample-${f}.bin bs=1M count=${perFileMB} 2>/dev/null`
          );
          ctx.collector.record(
            METRICS.BACKUP_RESTORED_WRITE_LATENCY,
            w.duration,
            'ms',
            { success: w.success, fileIndex: f }
          );
        }

        // ── Cleanup ──
        await ctx.manager.executeCommand(
          sandbox,
          `fusermount3 -u ${restoreDir} 2>/dev/null || true; rm -rf ${srcDir} ${restoreDir}`
        );
      }

      // ── Per-size report ──
      const createStats = ctx.collector.getStats(
        `${METRICS.BACKUP_CREATE_LATENCY}-${label}`
      );
      const restoreStats = ctx.collector.getStats(
        `${METRICS.BACKUP_RESTORE_LATENCY}-${label}`
      );
      const readStats = ctx.collector.getStats(
        `${METRICS.BACKUP_BULK_READ_THROUGHPUT}-${label}`
      );
      const writeStats = ctx.collector.getStats(
        `${METRICS.BACKUP_BULK_WRITE_THROUGHPUT}-${label}`
      );

      console.log(`    ${label} (${fileCount}×${perFileMB}MB):`);
      if (createStats) {
        console.log(`      backup:  p50=${createStats.p50.toFixed(0)}ms`);
      }
      if (restoreStats) {
        console.log(`      restore: p50=${restoreStats.p50.toFixed(0)}ms`);
      }
      if (readStats) {
        console.log(`      read:    p50=${readStats.p50.toFixed(1)} MB/s`);
      }
      if (writeStats) {
        console.log(`      write:   p50=${writeStats.p50.toFixed(1)} MB/s`);
      }
    }

    const createRate = ctx.collector.getSuccessRate(
      `${METRICS.BACKUP_CREATE_LATENCY}-100mb`
    );
    expect(createRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 1800000);
});
