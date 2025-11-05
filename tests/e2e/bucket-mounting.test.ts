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
  createTestHeaders,
  fetchWithStartup
} from './helpers/test-fixtures';
import {
  getTestWorkerUrl,
  type WranglerDevRunner
} from './helpers/wrangler-runner';

/**
 * E2E test for S3-compatible bucket mounting
 *
 * This test validates the complete bucket mounting workflow:
 * 1. Mount an R2 bucket using explicit endpoint URL
 * 2. Write files via the mounted filesystem
 * 3. Read files back to verify
 * 4. List directory contents
 *
 * Requires:
 * - R2 bucket: sandbox-e2e-test
 * - Credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * - Account: CLOUDFLARE_ACCOUNT_ID (used to construct endpoint)
 *
 * Note: This test requires FUSE device access and only runs in CI.
 * Local wrangler dev doesn't expose /dev/fuse to containers.
 */
describe('Bucket Mounting E2E', () => {
  const requiredEnvVars = [
    'CLOUDFLARE_ACCOUNT_ID',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY'
  ];

  // Check if we have credentials to run this test
  const hasCredentials = requiredEnvVars.every((key) => !!process.env[key]);

  if (!hasCredentials) {
    test.skip('Skipping E2E test - missing R2 credentials', () => {
      console.log('\n⚠️  Bucket mounting E2E test requires R2 credentials:');
      requiredEnvVars.forEach((key) => {
        console.log(`  ${key}: ${process.env[key] ? '✓' : '✗ missing'}`);
      });
      console.log('\nSet these environment variables to run E2E tests.\n');
    });
    return;
  }

  // Skip test when running locally (requires FUSE device access only available in CI)
  const isCI = !!process.env.TEST_WORKER_URL;
  if (!isCI) {
    test.skip('Skipping E2E test - requires FUSE device access (CI only)', () => {
      console.log(
        '\n⚠️  Bucket mounting E2E test requires FUSE device access (only available in CI)\n'
      );
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
      // Get test worker URL (CI: deployed URL, Local: spawns wrangler dev)
      const result = await getTestWorkerUrl();
      workerUrl = result.url;
      runner = result.runner;

      console.log(`\n🔧 E2E Test Configuration:`);
      console.log(`  Worker URL: ${workerUrl}`);
      console.log(`  Bucket: ${TEST_BUCKET}`);
      console.log(`  Mount Path: ${MOUNT_PATH}`);
      console.log(`  Test File: ${TEST_FILE}\n`);
    }, 30000);

    afterEach(async () => {
      // Cleanup sandbox after each test
      if (currentSandboxId) {
        await cleanupSandbox(workerUrl, currentSandboxId);
        currentSandboxId = null;
      }
    });

    afterAll(async () => {
      // Stop wrangler dev (only in local mode)
      if (runner) {
        await runner.stop();
      }
    });

    test('should mount R2 bucket and perform file operations', async () => {
      currentSandboxId = createSandboxId();
      const headers = createTestHeaders(currentSandboxId);

      console.log(`\n🪣 Step 1: Mounting bucket ${TEST_BUCKET}...`);

      // Mount the R2 bucket
      const mountResponse = await vi.waitFor(
        async () =>
          fetchWithStartup(`${workerUrl}/api/bucket/mount`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              bucket: TEST_BUCKET,
              mountPath: MOUNT_PATH,
              options: {
                endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
              }
            })
          }),
        { timeout: 60000, interval: 2000 }
      );

      expect(mountResponse.ok).toBe(true);
      const mountResult = await mountResponse.json();
      expect(mountResult.success).toBe(true);
      console.log(`✅ Bucket mounted successfully`);

      // Verify mount point exists
      console.log(`\n📂 Step 2: Verifying mount point...`);
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
      console.log(`✅ Mount point verified at ${MOUNT_PATH}`);

      // Write test file to mounted bucket
      console.log(`\n✏️  Step 3: Writing test file...`);
      const writeResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `echo "${TEST_CONTENT}" > ${MOUNT_PATH}/${TEST_FILE}`
        })
      });

      const writeResult = await writeResponse.json();
      expect(writeResult.exitCode).toBe(0);
      console.log(`✅ Test file written: ${TEST_FILE}`);

      // Read file back
      console.log(`\n📖 Step 4: Reading file back...`);
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
      console.log(`✅ File content verified`);
      console.log(`   Content: "${readResult.stdout?.trim()}"`);

      // List directory contents
      console.log(`\n📋 Step 5: Listing directory...`);
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
      console.log(`✅ Directory listing successful`);
      console.log(`   ${lsResult.stdout?.trim()}`);

      // Cleanup: delete test file
      console.log(`\n🧹 Step 6: Cleaning up test file...`);
      const cleanupResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: `rm -f ${MOUNT_PATH}/${TEST_FILE}`
        })
      });

      const cleanupResult = await cleanupResponse.json();
      expect(cleanupResult.exitCode).toBe(0);
      console.log(`✅ Test file removed`);

      console.log(`\n✅ All E2E bucket mounting tests passed!\n`);
    }, 120000); // 2 minute timeout
  });
});
