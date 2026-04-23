/**
 * Backup & Restore Performance Test
 *
 * Measures backup creation and restore latencies across multiple directory sizes:
 * - 100mb
 * - 500mb
 * - 1gb
 *
 * Data is generated from /dev/urandom so it is effectively incompressible —
 * this prevents squashfs compression from masking real I/O / transfer costs.
 *
 * Also measures post-restore read/write latency to verify the restored
 * filesystem is fully functional.
 *
 * Requires BACKUP_BUCKET R2 binding on the deployed test worker.
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

describe('Backup & Restore', () => {
  const ctx = createPerfTestContext(SCENARIOS.BACKUP_RESTORE);
  let sandbox: SandboxInstance;
  let manager: PerfSandboxManager;
  let shouldRun = false;

  const ITERATIONS = 3;

  const DIR_SIZES: Array<{
    label: string;
    fileCount: number;
    fileSizeMB: number;
  }> = [
    { label: '100mb', fileCount: 4, fileSizeMB: 25 },
    { label: '500mb', fileCount: 5, fileSizeMB: 100 },
    { label: '1gb', fileCount: 8, fileSizeMB: 128 }
  ];

  /**
   * Build a shell command that populates `dir` with `fileCount` files of
   * `fileSizeMB` each, sourced from /dev/urandom so the data is
   * pseudorandom (and therefore near-incompressible by squashfs).
   */
  function populateDirCmd(
    dir: string,
    fileCount: number,
    fileSizeMB: number
  ): string {
    const cmds = [`mkdir -p ${dir}`];
    for (let f = 0; f < fileCount; f++) {
      cmds.push(
        `dd if=/dev/urandom of=${dir}/file-${f}.bin bs=1M count=${fileSizeMB} status=none`
      );
    }
    return cmds.join(' && ');
  }

  beforeAll(async () => {
    const deployedUrl = process.env.PERF_DEPLOYED_WORKER_URL;
    if (!deployedUrl) {
      console.warn(
        'PERF_DEPLOYED_WORKER_URL not set — backup perf tests will be skipped'
      );
      return;
    }

    manager = new PerfSandboxManager({ workerUrl: deployedUrl });
    sandbox = await manager.createSandbox({ initialize: true });

    // Probe for BACKUP_BUCKET availability
    const probe = await manager.createBackup(sandbox, '/nonexistent-probe-dir');
    // If the error mentions BACKUP_BUCKET or "not configured", the binding is missing
    if (
      probe.error?.includes('BACKUP_BUCKET') ||
      probe.error?.includes('not configured')
    ) {
      console.warn(
        'BACKUP_BUCKET R2 binding not configured — backup perf tests will be skipped'
      );
    } else {
      shouldRun = true;
    }
  }, 120000);

  afterAll(async () => {
    if (manager) await manager.destroyAll();
    registerPerfScenario(ctx);
  });

  test('should measure backup creation latency by directory size', async () => {
    if (!shouldRun) {
      console.log('  Skipped — deployed worker / BACKUP_BUCKET not available');
      return;
    }

    for (const { label, fileCount, fileSizeMB } of DIR_SIZES) {
      console.log(
        `\n  Backup create ${label} (${fileCount} files × ${fileSizeMB} MB urandom, ${ITERATIONS} iterations):`
      );

      for (let i = 0; i < ITERATIONS; i++) {
        const dir = `/tmp/perf-backup-${label}-${i}`;

        await manager.executeCommand(
          sandbox,
          populateDirCmd(dir, fileCount, fileSizeMB),
          { timeout: 600000 }
        );

        const result = await manager.createBackup(sandbox, dir, {
          name: `perf-${label}-${i}`,
          ttl: 3600
        });

        ctx.collector.record(
          `${METRICS.BACKUP_CREATE_LATENCY}-${label}`,
          result.duration,
          'ms',
          { success: result.success, iteration: i }
        );

        // Cleanup directory
        await manager.executeCommand(
          sandbox,
          `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir}`
        );
      }

      const stats = ctx.collector.getStats(
        `${METRICS.BACKUP_CREATE_LATENCY}-${label}`
      );
      if (stats) {
        console.log(
          `    p50=${stats.p50.toFixed(0)}ms  p95=${stats.p95.toFixed(0)}ms`
        );
      }
    }

    const smallRate = ctx.collector.getSuccessRate(
      `${METRICS.BACKUP_CREATE_LATENCY}-100mb`
    );
    expect(smallRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 3_600_000);

  test('should measure backup restore latency by directory size', async () => {
    if (!shouldRun) {
      console.log('  Skipped — deployed worker / BACKUP_BUCKET not available');
      return;
    }

    for (const { label, fileCount, fileSizeMB } of DIR_SIZES) {
      console.log(
        `\n  Backup restore ${label} (${fileCount} files × ${fileSizeMB} MB urandom, ${ITERATIONS} iterations):`
      );

      for (let i = 0; i < ITERATIONS; i++) {
        const dir = `/tmp/perf-restore-${label}-${i}`;

        await manager.executeCommand(
          sandbox,
          populateDirCmd(dir, fileCount, fileSizeMB),
          { timeout: 600000 }
        );

        const backup = await manager.createBackup(sandbox, dir, {
          name: `perf-restore-${label}-${i}`,
          ttl: 3600
        });

        if (!backup.success || !backup.id) {
          ctx.collector.record(
            `${METRICS.BACKUP_RESTORE_LATENCY}-${label}`,
            0,
            'ms',
            { success: false, iteration: i, error: 'backup creation failed' }
          );
          await manager.executeCommand(
            sandbox,
            `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir}`
          );
          continue;
        }

        // Wipe the directory
        await manager.executeCommand(
          sandbox,
          `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir} && mkdir -p ${dir}`
        );

        // Measure restore
        const result = await manager.restoreBackup(sandbox, backup.id, dir);

        ctx.collector.record(
          `${METRICS.BACKUP_RESTORE_LATENCY}-${label}`,
          result.duration,
          'ms',
          { success: result.success, iteration: i }
        );

        // Cleanup
        await manager.executeCommand(
          sandbox,
          `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir}`
        );
      }

      const stats = ctx.collector.getStats(
        `${METRICS.BACKUP_RESTORE_LATENCY}-${label}`
      );
      if (stats) {
        console.log(
          `    p50=${stats.p50.toFixed(0)}ms  p95=${stats.p95.toFixed(0)}ms`
        );
      }
    }

    const smallRate = ctx.collector.getSuccessRate(
      `${METRICS.BACKUP_RESTORE_LATENCY}-100mb`
    );
    expect(smallRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 3_600_000);

  test('should measure post-restore read and write latency', async () => {
    if (!shouldRun) {
      console.log('  Skipped — deployed worker / BACKUP_BUCKET not available');
      return;
    }

    console.log(`\n  Post-restore I/O (${ITERATIONS} iterations):`);

    for (let i = 0; i < ITERATIONS; i++) {
      const dir = `/tmp/perf-post-restore-${i}`;
      const content = `perf-test-content-${i}`;

      // Create, backup, wipe, restore
      await manager.executeCommand(
        sandbox,
        `mkdir -p ${dir} && echo "${content}" > ${dir}/test.txt`
      );

      const backup = await manager.createBackup(sandbox, dir, {
        name: `perf-post-${i}`,
        ttl: 3600
      });

      if (!backup.success || !backup.id) {
        await manager.executeCommand(
          sandbox,
          `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir}`
        );
        continue;
      }

      await manager.executeCommand(
        sandbox,
        `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir} && mkdir -p ${dir}`
      );
      await manager.restoreBackup(sandbox, backup.id, dir);

      // Measure read after restore
      const readResult = await manager.executeCommand(
        sandbox,
        `cat ${dir}/test.txt`
      );
      ctx.collector.record(
        METRICS.BACKUP_READ_AFTER_RESTORE,
        readResult.duration,
        'ms',
        {
          success: readResult.success && readResult.stdout.trim() === content,
          iteration: i
        }
      );

      // Measure write after restore
      const writeResult = await manager.executeCommand(
        sandbox,
        `echo "new-content-${i}" > ${dir}/new-file.txt`
      );
      ctx.collector.record(
        METRICS.BACKUP_WRITE_AFTER_RESTORE,
        writeResult.duration,
        'ms',
        { success: writeResult.success, iteration: i }
      );

      // Cleanup
      await manager.executeCommand(
        sandbox,
        `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir}`
      );
    }

    const readStats = ctx.collector.getStats(METRICS.BACKUP_READ_AFTER_RESTORE);
    const writeStats = ctx.collector.getStats(
      METRICS.BACKUP_WRITE_AFTER_RESTORE
    );
    if (readStats) {
      console.log(
        `    Read  p50=${readStats.p50.toFixed(0)}ms  p95=${readStats.p95.toFixed(0)}ms`
      );
    }
    if (writeStats) {
      console.log(
        `    Write p50=${writeStats.p50.toFixed(0)}ms  p95=${writeStats.p95.toFixed(0)}ms`
      );
    }

    const readRate = ctx.collector.getSuccessRate(
      METRICS.BACKUP_READ_AFTER_RESTORE
    );
    expect(readRate.rate).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 600000);
});
