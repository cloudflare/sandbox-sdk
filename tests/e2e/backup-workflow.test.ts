import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

// Response types for type assertions
interface BackupResponse {
  id: string;
  dir: string;
}

interface RestoreResponse {
  success: boolean;
}

interface ExecuteResponse {
  stdout?: string;
  exitCode?: number;
}

interface ErrorResponse {
  code?: string;
  error?: string;
}

/**
 * Helper to clean up a directory that may have a FUSE overlay mount.
 * Unmounts first (silently ignoring errors if not mounted), then removes.
 */
async function cleanupDir(
  workerUrl: string,
  headers: Record<string, string>,
  dir: string
): Promise<void> {
  await fetch(`${workerUrl}/api/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      command: `fusermount3 -u ${dir} 2>/dev/null || true; rm -rf ${dir}`
    })
  });
}

/**
 * E2E tests for backup/restore functionality
 *
 * Tests the full backup workflow:
 * 1. Create files in a directory
 * 2. Create a backup (squashfs archive → R2)
 * 3. Modify/delete the original files
 * 4. Restore the backup
 * 5. Verify files are restored correctly
 *
 * Requires:
 * - BACKUP_BUCKET R2 binding configured in test worker
 * - Only runs in CI environment with proper bindings
 */
describe('Backup Workflow E2E', () => {
  const isCI = !!process.env.TEST_WORKER_URL;

  if (!isCI) {
    test.skip('Skipping - requires CI environment with BACKUP_BUCKET binding', () => {});
    return;
  }

  let workerUrl: string;
  let headers: Record<string, string>;
  let backupBucketAvailable = false;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());

    // Probe for BACKUP_BUCKET availability once at suite level
    const probeResponse = await fetch(`${workerUrl}/api/backup/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ dir: '/nonexistent-probe-dir' })
    });
    const probeText = await probeResponse.text();
    if (
      probeText.includes('BACKUP_BUCKET') ||
      probeText.includes('not configured')
    ) {
      console.warn(
        'BACKUP_BUCKET R2 binding not configured — backup tests will be skipped'
      );
    } else {
      backupBucketAvailable = true;
    }
  }, 120000);

  describe('Basic backup and restore', () => {
    const TEST_DIR = `/workspace/backup-test-${crypto.randomUUID().slice(0, 8)}`;
    const TEST_FILE = 'test-file.txt';
    const TEST_CONTENT = `Backup test content - ${new Date().toISOString()}`;

    test('should backup and restore a directory', async () => {
      if (!backupBucketAvailable) return;

      // Step 1: Create test directory and files
      const mkdirResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `mkdir -p ${TEST_DIR} && echo "${TEST_CONTENT}" > ${TEST_DIR}/${TEST_FILE}`
        })
      });
      expect(mkdirResponse.ok).toBe(true);

      // Step 2: Create backup
      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dir: TEST_DIR,
          name: 'e2e-test-backup',
          ttl: 3600 // 1 hour
        })
      });

      if (!backupResponse.ok) {
        const errorText = await backupResponse.text();
        throw new Error(`Backup creation failed: ${errorText}`);
      }

      const backup = (await backupResponse.json()) as BackupResponse;
      expect(backup.id).toBeDefined();
      expect(backup.dir).toBe(TEST_DIR);

      // Step 3: Delete original files
      const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `rm -rf ${TEST_DIR}/*`
        })
      });
      expect(deleteResponse.ok).toBe(true);

      // Verify files are gone
      const checkDeletedResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `test -f ${TEST_DIR}/${TEST_FILE} && echo "exists" || echo "deleted"`
        })
      });
      const checkDeletedResult =
        (await checkDeletedResponse.json()) as ExecuteResponse;
      expect(checkDeletedResult.stdout?.trim()).toBe('deleted');

      // Step 4: Restore backup
      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: backup.id,
          dir: TEST_DIR
        })
      });
      expect(restoreResponse.ok).toBe(true);

      const restoreResult = (await restoreResponse.json()) as RestoreResponse;
      expect(restoreResult.success).toBe(true);

      // Step 5: Verify files are restored
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cat ${TEST_DIR}/${TEST_FILE}`
        })
      });
      const verifyResult = (await verifyResponse.json()) as ExecuteResponse;
      expect(verifyResult.exitCode).toBe(0);
      expect(verifyResult.stdout?.trim()).toBe(TEST_CONTENT);

      // Cleanup (unmounts FUSE overlay if present, then removes directory)
      await cleanupDir(workerUrl, headers, TEST_DIR);
    }, 60000);
  });

  describe('Nested directory tree backup', () => {
    test('should backup and restore a directory tree with nested files', async () => {
      if (!backupBucketAvailable) return;

      const PROJECT_DIR = `/workspace/tree-backup-test-${crypto.randomUUID().slice(0, 8)}`;

      // Step 1: Create nested directory structure with known content
      const setupResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: [
            `mkdir -p ${PROJECT_DIR}/src/utils ${PROJECT_DIR}/config`,
            `echo 'console.log("main")' > ${PROJECT_DIR}/src/index.js`,
            `echo 'export const VERSION = "1.0.0"' > ${PROJECT_DIR}/src/utils/version.js`,
            `echo '{"port": 3000}' > ${PROJECT_DIR}/config/settings.json`
          ].join(' && ')
        })
      });
      expect(setupResponse.ok).toBe(true);

      // Step 2: Record file checksums before backup
      const checksumBeforeResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `find ${PROJECT_DIR} -type f | sort | xargs md5sum`
        })
      });
      const checksumBeforeResult =
        (await checksumBeforeResponse.json()) as ExecuteResponse;
      expect(checksumBeforeResult.exitCode).toBe(0);
      const checksumBefore = checksumBeforeResult.stdout?.trim();

      // Step 3: Create backup
      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dir: PROJECT_DIR,
          name: 'nested-tree-backup',
          ttl: 3600
        })
      });

      if (!backupResponse.ok) {
        const errorText = await backupResponse.text();
        throw new Error(`Backup creation failed: ${errorText}`);
      }

      const backup = (await backupResponse.json()) as BackupResponse;
      expect(backup.id).toBeDefined();

      // Step 4: Delete all files
      const deleteResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `rm -rf ${PROJECT_DIR}/*`
        })
      });
      expect(deleteResponse.ok).toBe(true);

      // Verify files are gone
      const verifyDeletedResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `find ${PROJECT_DIR} -type f | wc -l`
        })
      });
      const verifyDeletedResult =
        (await verifyDeletedResponse.json()) as ExecuteResponse;
      expect(verifyDeletedResult.stdout?.trim()).toBe('0');

      // Step 5: Restore backup
      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: backup.id,
          dir: PROJECT_DIR
        })
      });
      expect(restoreResponse.ok).toBe(true);

      // Step 6: Verify checksums match
      const checksumAfterResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `find ${PROJECT_DIR} -type f | sort | xargs md5sum`
        })
      });
      const checksumAfterResult =
        (await checksumAfterResponse.json()) as ExecuteResponse;
      expect(checksumAfterResult.exitCode).toBe(0);
      expect(checksumAfterResult.stdout?.trim()).toBe(checksumBefore);

      // Cleanup (unmounts FUSE overlay if present, then removes directory)
      await cleanupDir(workerUrl, headers, PROJECT_DIR);
    }, 60000);
  });

  describe('Empty directory backup', () => {
    test('should backup and restore an empty directory', async () => {
      if (!backupBucketAvailable) return;

      const EMPTY_DIR = `/workspace/empty-backup-test-${crypto.randomUUID().slice(0, 8)}`;

      // Create empty directory
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `mkdir -p ${EMPTY_DIR}` })
      });

      // Create backup
      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ dir: EMPTY_DIR })
      });

      expect(backupResponse.ok).toBe(true);
      const backup = (await backupResponse.json()) as BackupResponse;

      // Delete and restore
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `rm -rf ${EMPTY_DIR}` })
      });

      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: backup.id, dir: EMPTY_DIR })
      });
      expect(restoreResponse.ok).toBe(true);

      // Verify directory exists
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `test -d ${EMPTY_DIR} && echo "exists" || echo "missing"`
        })
      });
      const verifyResult = (await verifyResponse.json()) as ExecuteResponse;
      expect(verifyResult.stdout?.trim()).toBe('exists');

      // Cleanup (unmounts FUSE overlay if present, then removes directory)
      await cleanupDir(workerUrl, headers, EMPTY_DIR);
    }, 60000);
  });

  describe('Expired backup rejection', () => {
    test('should reject restoring an expired backup', async () => {
      if (!backupBucketAvailable) return;

      const TEST_DIR = `/workspace/expired-backup-test-${crypto.randomUUID().slice(0, 8)}`;

      // Create directory with content
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `mkdir -p ${TEST_DIR} && echo "test" > ${TEST_DIR}/file.txt`
        })
      });

      // Create backup with very short TTL (1 second)
      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dir: TEST_DIR,
          ttl: 1 // 1 second TTL
        })
      });

      expect(backupResponse.ok).toBe(true);
      const backup = (await backupResponse.json()) as BackupResponse;

      // Wait for backup to expire (TTL + buffer = 61+ seconds)
      // With the 60-second buffer, it should be rejected immediately after 1 second
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Try to restore - should fail due to expiration
      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: backup.id, dir: TEST_DIR })
      });

      // Should fail with 400 (BACKUP_EXPIRED)
      expect(restoreResponse.status).toBe(400);
      const errorResult = (await restoreResponse.json()) as ErrorResponse;
      expect(errorResult.code).toBe('BACKUP_EXPIRED');

      // Cleanup (unmounts FUSE overlay if present, then removes directory)
      await cleanupDir(workerUrl, headers, TEST_DIR);
    }, 120000);
  });

  describe('Invalid backup ID rejection', () => {
    test('should reject non-existent backup ID', async () => {
      if (!backupBucketAvailable) return;

      const fakeBackupId = '00000000-0000-0000-0000-000000000000';

      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: fakeBackupId,
          dir: '/workspace/test'
        })
      });

      // Should fail with 404 (BACKUP_NOT_FOUND)
      expect(restoreResponse.status).toBe(404);
      const errorResult = (await restoreResponse.json()) as ErrorResponse;
      expect(errorResult.code).toBe('BACKUP_NOT_FOUND');
    }, 30000);

    test('should reject invalid backup ID format', async () => {
      if (!backupBucketAvailable) return;

      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'not-a-valid-uuid',
          dir: '/workspace/test'
        })
      });

      // Should fail with 400 (INVALID_BACKUP_CONFIG or validation error)
      expect(restoreResponse.status).toBe(400);
    }, 30000);
  });

  describe('Path validation', () => {
    test('should reject relative paths', async () => {
      if (!backupBucketAvailable) return;

      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dir: 'relative/path' // Not absolute
        })
      });

      // Should fail with 400 (validation error)
      expect(backupResponse.status).toBe(400);
    }, 30000);

    test('should reject path traversal attempts', async () => {
      if (!backupBucketAvailable) return;

      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dir: '/workspace/../../../etc/passwd'
        })
      });

      // Should fail with 400 (validation error)
      expect(backupResponse.status).toBe(400);
    }, 30000);
  });

  describe('Concurrent backup operations', () => {
    test('should handle concurrent backup requests without corruption', async () => {
      if (!backupBucketAvailable) return;

      const DIR_A = `/workspace/concurrent-a-${crypto.randomUUID().slice(0, 8)}`;
      const DIR_B = `/workspace/concurrent-b-${crypto.randomUUID().slice(0, 8)}`;

      // Create two directories with different content
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `mkdir -p ${DIR_A} ${DIR_B} && echo "content-a" > ${DIR_A}/file.txt && echo "content-b" > ${DIR_B}/file.txt`
        })
      });

      // Start both backups concurrently
      const [backupA, backupB] = await Promise.all([
        fetch(`${workerUrl}/api/backup/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ dir: DIR_A, name: 'concurrent-a' })
        }),
        fetch(`${workerUrl}/api/backup/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ dir: DIR_B, name: 'concurrent-b' })
        })
      ]);

      expect(backupA.ok).toBe(true);
      expect(backupB.ok).toBe(true);

      const backupDataA = (await backupA.json()) as BackupResponse;
      const backupDataB = (await backupB.json()) as BackupResponse;

      // Verify both backups have unique IDs
      expect(backupDataA.id).not.toBe(backupDataB.id);

      // Delete original content
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `rm -rf ${DIR_A}/* ${DIR_B}/*`
        })
      });

      // Restore both backups
      const [restoreA, restoreB] = await Promise.all([
        fetch(`${workerUrl}/api/backup/restore`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: backupDataA.id, dir: DIR_A })
        }),
        fetch(`${workerUrl}/api/backup/restore`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: backupDataB.id, dir: DIR_B })
        })
      ]);

      expect(restoreA.ok).toBe(true);
      expect(restoreB.ok).toBe(true);

      // Verify content is correct (not mixed up)
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cat ${DIR_A}/file.txt && echo "---" && cat ${DIR_B}/file.txt`
        })
      });
      const verifyResult = (await verifyResponse.json()) as ExecuteResponse;
      const [contentA, , contentB] = (verifyResult.stdout || '').split('\n');
      expect(contentA).toBe('content-a');
      expect(contentB).toBe('content-b');

      // Cleanup
      await cleanupDir(workerUrl, headers, DIR_A);
      await cleanupDir(workerUrl, headers, DIR_B);
    }, 120000);
  });

  describe('Special characters in paths', () => {
    test('should handle filenames with spaces and unicode', async () => {
      if (!backupBucketAvailable) return;

      const TEST_DIR = `/workspace/special-chars-${crypto.randomUUID().slice(0, 8)}`;

      // Create files with special characters in names
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: [
            `mkdir -p "${TEST_DIR}"`,
            `echo "space content" > "${TEST_DIR}/file with spaces.txt"`,
            `echo "emoji content" > "${TEST_DIR}/emoji-🎉-file.txt"`,
            `echo "unicode content" > "${TEST_DIR}/日本語ファイル.txt"`
          ].join(' && ')
        })
      });

      // Create backup
      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ dir: TEST_DIR })
      });

      if (!backupResponse.ok) {
        const errorText = await backupResponse.text();
        throw new Error(`Backup creation failed: ${errorText}`);
      }

      const backup = (await backupResponse.json()) as BackupResponse;

      // Delete files
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `rm -rf "${TEST_DIR}"/*` })
      });

      // Restore
      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: backup.id, dir: TEST_DIR })
      });
      expect(restoreResponse.ok).toBe(true);

      // Verify all files exist and have correct content
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cat "${TEST_DIR}/file with spaces.txt" && cat "${TEST_DIR}/emoji-🎉-file.txt" && cat "${TEST_DIR}/日本語ファイル.txt"`
        })
      });
      const verifyResult = (await verifyResponse.json()) as ExecuteResponse;
      expect(verifyResult.exitCode).toBe(0);
      expect(verifyResult.stdout).toContain('space content');
      expect(verifyResult.stdout).toContain('emoji content');
      expect(verifyResult.stdout).toContain('unicode content');

      // Cleanup
      await cleanupDir(workerUrl, headers, TEST_DIR);
    }, 60000);
  });

  describe('Restore to different location', () => {
    test('should restore backup to a different directory than original', async () => {
      if (!backupBucketAvailable) return;

      const ORIGINAL_DIR = `/workspace/original-${crypto.randomUUID().slice(0, 8)}`;
      const RESTORE_DIR = `/workspace/restored-${crypto.randomUUID().slice(0, 8)}`;

      // Create original directory with content
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `mkdir -p ${ORIGINAL_DIR}/subdir && echo "original" > ${ORIGINAL_DIR}/file.txt && echo "nested" > ${ORIGINAL_DIR}/subdir/nested.txt`
        })
      });

      // Create backup of original
      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ dir: ORIGINAL_DIR })
      });

      expect(backupResponse.ok).toBe(true);
      const backup = (await backupResponse.json()) as BackupResponse;

      // Restore to DIFFERENT location
      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: backup.id, dir: RESTORE_DIR })
      });
      expect(restoreResponse.ok).toBe(true);

      // Verify content exists in new location
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cat ${RESTORE_DIR}/file.txt && cat ${RESTORE_DIR}/subdir/nested.txt`
        })
      });
      const verifyResult = (await verifyResponse.json()) as ExecuteResponse;
      expect(verifyResult.exitCode).toBe(0);
      expect(verifyResult.stdout).toContain('original');
      expect(verifyResult.stdout).toContain('nested');

      // Verify original is still intact
      const originalCheck = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `cat ${ORIGINAL_DIR}/file.txt` })
      });
      const originalResult = (await originalCheck.json()) as ExecuteResponse;
      expect(originalResult.stdout?.trim()).toBe('original');

      // Cleanup both directories
      await cleanupDir(workerUrl, headers, ORIGINAL_DIR);
      await cleanupDir(workerUrl, headers, RESTORE_DIR);
    }, 60000);
  });

  describe('Overlayfs copy-on-write behavior', () => {
    test('should allow writes after restore without affecting backup', async () => {
      if (!backupBucketAvailable) return;

      const TEST_DIR = `/workspace/cow-test-${crypto.randomUUID().slice(0, 8)}`;

      // Create original content
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `mkdir -p ${TEST_DIR} && echo "original" > ${TEST_DIR}/file.txt`
        })
      });

      // Create backup
      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ dir: TEST_DIR })
      });
      expect(backupResponse.ok).toBe(true);
      const backup = (await backupResponse.json()) as BackupResponse;

      // Delete and restore
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `rm -rf ${TEST_DIR}/*` })
      });

      const restoreResponse = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: backup.id, dir: TEST_DIR })
      });
      expect(restoreResponse.ok).toBe(true);

      // Write NEW content to restored directory (should use COW)
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `echo "modified" > ${TEST_DIR}/file.txt && echo "new file" > ${TEST_DIR}/new.txt`
        })
      });

      // Verify modified content
      const modifiedCheck = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cat ${TEST_DIR}/file.txt && cat ${TEST_DIR}/new.txt`
        })
      });
      const modifiedResult = (await modifiedCheck.json()) as ExecuteResponse;
      expect(modifiedResult.stdout).toContain('modified');
      expect(modifiedResult.stdout).toContain('new file');

      // Cleanup and restore again - should get ORIGINAL content (not modified)
      await cleanupDir(workerUrl, headers, TEST_DIR);

      const restore2Response = await fetch(`${workerUrl}/api/backup/restore`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: backup.id, dir: TEST_DIR })
      });
      expect(restore2Response.ok).toBe(true);

      // Verify original content is back
      const originalCheck = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `cat ${TEST_DIR}/file.txt` })
      });
      const originalResult = (await originalCheck.json()) as ExecuteResponse;
      expect(originalResult.stdout?.trim()).toBe('original');

      // Verify new.txt doesn't exist (wasn't in backup)
      const newFileCheck = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `test -f ${TEST_DIR}/new.txt && echo "exists" || echo "missing"`
        })
      });
      const newFileResult = (await newFileCheck.json()) as ExecuteResponse;
      expect(newFileResult.stdout?.trim()).toBe('missing');

      // Cleanup
      await cleanupDir(workerUrl, headers, TEST_DIR);
    }, 90000);
  });

  describe('Cleanup after failed restore', () => {
    test('should not leave partial state after restore failure', async () => {
      if (!backupBucketAvailable) return;

      const TEST_DIR = `/workspace/failed-restore-${crypto.randomUUID().slice(0, 8)}`;

      // Create and backup a directory
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `mkdir -p ${TEST_DIR} && echo "test" > ${TEST_DIR}/file.txt`
        })
      });

      const backupResponse = await fetch(`${workerUrl}/api/backup/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ dir: TEST_DIR })
      });
      expect(backupResponse.ok).toBe(true);
      const backup = (await backupResponse.json()) as BackupResponse;

      // Clean the test dir
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `rm -rf ${TEST_DIR}` })
      });

      // Try to restore to an invalid path (should fail)
      const invalidRestoreResponse = await fetch(
        `${workerUrl}/api/backup/restore`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: backup.id, dir: '/proc/invalid-restore' })
        }
      );

      // Should fail (either 400 for validation or 500 for filesystem error)
      expect(invalidRestoreResponse.ok).toBe(false);

      // Verify no mounts were left hanging in /var/backups/mounts
      const mountCheck = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `mount | grep -c "overlay.*${backup.id}" 2>/dev/null || true`
        })
      });
      const mountResult = (await mountCheck.json()) as ExecuteResponse;
      // Should be 0 (no orphan mounts) - grep -c returns "0" when no matches
      expect(mountResult.stdout?.trim()).toBe('0');

      // Now do a successful restore to verify the backup still works
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `mkdir -p ${TEST_DIR}` })
      });

      const validRestoreResponse = await fetch(
        `${workerUrl}/api/backup/restore`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: backup.id, dir: TEST_DIR })
        }
      );
      expect(validRestoreResponse.ok).toBe(true);

      // Verify content
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: `cat ${TEST_DIR}/file.txt` })
      });
      const verifyResult = (await verifyResponse.json()) as ExecuteResponse;
      expect(verifyResult.stdout?.trim()).toBe('test');

      // Cleanup
      await cleanupDir(workerUrl, headers, TEST_DIR);
    }, 90000);
  });
});
