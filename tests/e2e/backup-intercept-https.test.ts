import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  createUniqueSession,
  type TestSandbox
} from './helpers/global-sandbox';

interface BackupResponse {
  id: string;
  dir: string;
}

interface ExecuteResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

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
 * E2E tests for backup/restore with interceptHttps=true and outbound handler.
 *
 * Reproduces https://github.com/cloudflare/sandbox-sdk/issues/619.
 *
 * The SandboxInterceptHttps class (in test-worker/index.ts) sets:
 *   interceptHttps = true
 *   static outbound = (req) => fetch(req)  // passthrough catch-all handler
 *
 * Under this configuration, s3fs Range GET requests to R2 pass through the
 * Cloudflare interception proxy and then the passthrough handler. The diagnostic
 * log ("Backup archive pre-restore diagnostic") emitted during restore reveals
 * whether the failure is due to:
 *   - Auth broken:  hex dump shows XML error body (e.g. "<?xml")
 *   - Range broken: hex dump shows correct bytes at wrong offset
 *   - Empty:        hex dump is empty / zero bytes
 *   - Correct:      hex dump starts with "73 71 73 68" (squashfs magic)
 *
 * Check Cloudflare Worker observability logs to read the diagnostic output.
 *
 * Requires:
 * - BACKUP_BUCKET R2 binding configured in wrangler.jsonc
 * - R2 API credentials (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID) in .dev.vars
 */
describe('Backup Restore with interceptHttps', () => {
  let regularSandbox: TestSandbox | null = null;
  let interceptSandbox: TestSandbox | null = null;
  let workerUrl: string;
  let backupBucketAvailable = false;

  beforeAll(async () => {
    regularSandbox = await createTestSandbox({ type: 'default' });
    interceptSandbox = await createTestSandbox({ type: 'intercepthttps' });
    workerUrl = regularSandbox.workerUrl;

    const probeResponse = await fetch(`${workerUrl}/api/backup/create`, {
      method: 'POST',
      headers: regularSandbox.headers(),
      body: JSON.stringify({ dir: '/nonexistent-probe-dir' })
    });
    const probeText = await probeResponse.text();
    if (
      !probeText.includes('BACKUP_BUCKET') &&
      !probeText.includes('not configured')
    ) {
      backupBucketAvailable = true;
    }
  }, 120000);

  afterAll(async () => {
    await Promise.all([
      cleanupTestSandbox(regularSandbox),
      cleanupTestSandbox(interceptSandbox)
    ]);
    regularSandbox = null;
    interceptSandbox = null;
  }, 120000);

  test('restore fails with interceptHttps=true + passthrough outbound handler (issue #619)', async () => {
    if (!backupBucketAvailable) return;

    const TEST_DIR = `/workspace/intercept-https-${crypto.randomUUID().slice(0, 8)}`;
    const regularHeaders = regularSandbox!.headers(createUniqueSession());
    const interceptHeaders = interceptSandbox!.headers(createUniqueSession());

    // Step 1: Create test files in the regular sandbox
    const mkdirRes = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: regularHeaders,
      body: JSON.stringify({
        command: `mkdir -p ${TEST_DIR} && echo "intercept-test-content" > ${TEST_DIR}/file.txt`
      })
    });
    expect(mkdirRes.ok).toBe(true);

    // Step 2: Create backup from regular sandbox (no interception)
    const backupRes = await fetch(`${workerUrl}/api/backup/create`, {
      method: 'POST',
      headers: regularHeaders,
      body: JSON.stringify({ dir: TEST_DIR, ttl: 3600 })
    });
    if (!backupRes.ok) {
      const err = await backupRes.text();
      throw new Error(`Backup create failed: ${err}`);
    }
    const backup = (await backupRes.json()) as BackupResponse;
    expect(backup.id).toBeDefined();

    // Step 3: Restore in interceptSandbox (interceptHttps=true + passthrough handler).
    // The diagnostic log "Backup archive pre-restore diagnostic" is emitted in the
    // DO logs and reveals what bytes s3fs serves to squashfuse. Check Worker logs.
    const restoreRes = await fetch(`${workerUrl}/api/backup/restore`, {
      method: 'POST',
      headers: interceptHeaders,
      body: JSON.stringify({ id: backup.id, dir: TEST_DIR })
    });

    // Currently expected to fail — restore corrupts data due to HTTPS interception.
    // When this test starts PASSING it means the issue is fixed.
    if (restoreRes.ok) {
      // Restore succeeded — verify files are actually correct
      const verifyRes = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: interceptHeaders,
        body: JSON.stringify({ command: `cat ${TEST_DIR}/file.txt` })
      });
      const verify = (await verifyRes.json()) as ExecuteResponse;
      expect(verify.stdout?.trim()).toBe('intercept-test-content');
      await cleanupDir(workerUrl, interceptHeaders, TEST_DIR);
    } else {
      // Confirm it fails with the known error code (not an unrelated error)
      const errBody = await restoreRes.json().catch(() => ({}));
      console.log(
        '[issue-619] restoreBackup response:',
        JSON.stringify(errBody)
      );
      expect(restoreRes.status).toBe(500);
    }
  }, 180000);

  test('backup creation succeeds with interceptHttps=true (presigned PUT unaffected)', async () => {
    if (!backupBucketAvailable) return;

    const TEST_DIR = `/workspace/intercept-create-${crypto.randomUUID().slice(0, 8)}`;
    const interceptHeaders = interceptSandbox!.headers(createUniqueSession());

    const mkdirRes = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: interceptHeaders,
      body: JSON.stringify({
        command: `mkdir -p ${TEST_DIR} && echo "create-test" > ${TEST_DIR}/file.txt`
      })
    });
    expect(mkdirRes.ok).toBe(true);

    const backupRes = await fetch(`${workerUrl}/api/backup/create`, {
      method: 'POST',
      headers: interceptHeaders,
      body: JSON.stringify({ dir: TEST_DIR, ttl: 3600 })
    });

    // Backup creation uses presigned PUT, which should not be broken.
    // If this also fails, the blast radius is broader than just restore.
    if (!backupRes.ok) {
      const errText = await backupRes.text();
      console.log('[issue-619] backup create also fails:', errText);
    }
    expect(backupRes.ok).toBe(true);
    const backup = (await backupRes.json()) as BackupResponse;
    expect(backup.id).toBeDefined();
  }, 180000);
});
