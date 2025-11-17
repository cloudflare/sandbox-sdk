import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi
} from 'vitest';
import {
  cleanupSandbox,
  createSandboxId,
  createTestHeaders
} from './helpers/test-fixtures';
import {
  getTestWorkerUrl,
  type WranglerDevRunner
} from './helpers/wrangler-runner';

/**
 * E2E test for S3-compatible bucket mounting
 *
 * Requires environment variables:
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare account ID
 *   AWS_ACCESS_KEY_ID - R2 access key ID
 *   AWS_SECRET_ACCESS_KEY - R2 secret access key
 *
 * Note: This test requires FUSE device access and only runs in CI.
 * Local wrangler dev doesn't expose /dev/fuse to containers.
 */
describe('Bucket Mounting E2E', () => {
  // Skip test when running locally (requires FUSE device access only available in CI)
  const isCI = !!process.env.TEST_WORKER_URL;
  if (!isCI) {
    test.skip('Skipping - requires FUSE device access (CI only)', () => {
      // Test skipped in local development
    });
    return;
  }

  describe('local', () => {
    let runner: WranglerDevRunner | null;
    let workerUrl: string;
    let currentSandboxId: string | null = null;

    const TEST_BUCKET = 'sandbox-e2e-test';
    const MOUNT_PATH = '/mnt/test-data';
    const TEST_FILE = `e2e-test-${Date.now()}.txt`;
    const TEST_CONTENT = `Bucket mounting E2E test - ${new Date().toISOString()}`;

    beforeAll(async () => {
      const result = await getTestWorkerUrl();
      workerUrl = result.url;
      runner = result.runner;
    }, 30000);

    afterEach(async () => {
      if (currentSandboxId) {
        await cleanupSandbox(workerUrl, currentSandboxId);
        currentSandboxId = null;
      }
    });

    afterAll(async () => {
      if (runner) {
        await runner.stop();
      }
    });

    test('should mount bucket and perform file operations', async () => {
      // Verify required credentials are present
      const requiredVars = [
        'CLOUDFLARE_ACCOUNT_ID',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY'
      ];
      const missing = requiredVars.filter((v) => !process.env[v]);

      if (missing.length > 0) {
        throw new Error(
          `Missing required environment variables: ${missing.join(', ')}`
        );
      }

      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      // Mount the bucket
      const mountResponse = await vi.waitFor(
        async () => {
          const res = await fetch(`${workerUrl}/api/bucket/mount`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              bucket: TEST_BUCKET,
              mountPath: MOUNT_PATH,
              options: {
                endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
              }
            })
          });
          if (!res.ok) throw new Error('Not ready');
          return res;
        },
        { timeout: 60000, interval: 2000 }
      );

      expect(mountResponse.ok).toBe(true);
      const mountResult = await mountResponse.json();
      expect(mountResult.success).toBe(true);

      // Verify mount point exists
      const verifyResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `test -d ${MOUNT_PATH} && echo "mounted"`
        })
      });

      const verifyResult = await verifyResponse.json();
      expect(verifyResult.stdout?.trim()).toBe('mounted');
      expect(verifyResult.exitCode).toBe(0);

      // Write test file to mounted bucket
      const writeResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `echo "${TEST_CONTENT}" > ${MOUNT_PATH}/${TEST_FILE}`
        })
      });

      const writeResult = await writeResponse.json();
      expect(writeResult.exitCode).toBe(0);

      // Read file back
      const readResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `cat ${MOUNT_PATH}/${TEST_FILE}`
        })
      });

      const readResult = await readResponse.json();
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout?.trim()).toBe(TEST_CONTENT);

      // List directory contents
      const lsResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `ls -lh ${MOUNT_PATH}/${TEST_FILE}`
        })
      });

      const lsResult = await lsResponse.json();
      expect(lsResult.exitCode).toBe(0);
      expect(lsResult.stdout).toContain(TEST_FILE);

      // Cleanup: delete test file
      const cleanupResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `rm -f ${MOUNT_PATH}/${TEST_FILE}`
        })
      });

      const cleanupResult = await cleanupResponse.json();
      expect(cleanupResult.exitCode).toBe(0);
    }, 120000); // 2 minute timeout
  });
});
