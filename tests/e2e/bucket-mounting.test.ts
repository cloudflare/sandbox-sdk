import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';
import type {
  BucketGetResponse,
  BucketUnmountResponse,
  SuccessResponse
} from './test-worker/types';

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
    let sandbox: TestSandbox | null = null;
    let workerUrl: string;
    let headers: Record<string, string>;

    const TEST_BUCKET = 'sandbox-e2e-test';
    const MOUNT_PATH = '/mnt/test-data';
    const TEST_FILE = `e2e-test-${Date.now()}.txt`;
    const TEST_CONTENT = `Bucket mounting E2E test - ${new Date().toISOString()}`;

    beforeAll(async () => {
      sandbox = await createTestSandbox();
      workerUrl = sandbox.workerUrl;
      headers = sandbox.headers();
    }, 120000);

    test('should mount bucket and perform bidirectional file operations', async () => {
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

      const PRE_EXISTING_FILE = `pre-existing-${Date.now()}.txt`;
      const PRE_EXISTING_CONTENT =
        'This file was created in R2 before mounting';

      try {
        // 1. Create a file in R2 via binding (before mounting)
        const putResponse = await fetch(`${workerUrl}/api/bucket/put`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            key: PRE_EXISTING_FILE,
            content: PRE_EXISTING_CONTENT,
            contentType: 'text/plain'
          })
        });
        expect(putResponse.ok).toBe(true);

        // 2. Mount the bucket (no vi.waitFor - let the SDK retry startup)
        const mountResponse = await fetch(`${workerUrl}/api/bucket/mount`, {
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
        expect(mountResponse.ok).toBe(true);
        const mountResult = (await mountResponse.json()) as SuccessResponse;
        expect(mountResult.success).toBe(true);

        // 3. Verify pre-existing R2 file appears in mount (R2 → Mount)
        const readPreExistingResponse = await fetch(
          `${workerUrl}/api/execute`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              command: [
                '/bin/bash',
                '-lc',
                `cat ${MOUNT_PATH}/${PRE_EXISTING_FILE}`
              ]
            })
          }
        );
        const readPreExistingResult =
          (await readPreExistingResponse.json()) as CommandResponse;
        expect(readPreExistingResult.exitCode).toBe(0);
        expect(readPreExistingResult.stdout?.trim()).toBe(PRE_EXISTING_CONTENT);

        // 4. Write new file via mount
        const writeResponse = await fetch(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: [
              '/bin/bash',
              '-lc',
              `echo "${TEST_CONTENT}" > ${MOUNT_PATH}/${TEST_FILE}`
            ]
          })
        });
        const writeResult = (await writeResponse.json()) as CommandResponse;
        expect(writeResult.exitCode).toBe(0);

        // 5. Verify new file appears in R2 via binding (Mount → R2)
        const getResponse = await fetch(
          `${workerUrl}/api/bucket/get?key=${TEST_FILE}`,
          {
            method: 'GET',
            headers
          }
        );
        expect(getResponse.ok).toBe(true);
        const getResult = (await getResponse.json()) as BucketGetResponse;
        expect(getResult.success).toBe(true);
        expect(getResult.content.trim()).toBe(TEST_CONTENT);

        // 6. Unmount the bucket
        const unmountResponse = await fetch(`${workerUrl}/api/bucket/unmount`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mountPath: MOUNT_PATH })
        });
        expect(unmountResponse.ok).toBe(true);
        const unmountResult =
          (await unmountResponse.json()) as BucketUnmountResponse;
        expect(unmountResult.success).toBe(true);

        // 7. Verify mount point is no longer active
        const mountCheck = await fetch(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: ['/bin/bash', '-lc', `mountpoint -q ${MOUNT_PATH}`]
          })
        });
        const mountCheckResult = (await mountCheck.json()) as CommandResponse;
        expect(mountCheckResult.exitCode).not.toBe(0);

        // 8. Verify mount directory was removed
        const dirCheck = await fetch(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: ['/bin/bash', '-lc', `test -d ${MOUNT_PATH}`]
          })
        });
        const dirCheckResult = (await dirCheck.json()) as CommandResponse;
        expect(dirCheckResult.exitCode).not.toBe(0);

        // 9. Cleanup: delete both test files from R2
        await fetch(`${workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: PRE_EXISTING_FILE })
        });

        await fetch(`${workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: TEST_FILE })
        });
      } catch (error) {
        // Cleanup on error
        await fetch(`${workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: PRE_EXISTING_FILE })
        }).catch(() => {});

        await fetch(`${workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: TEST_FILE })
        }).catch(() => {});

        throw error;
      }
    }, 120000); // 2 minute timeout

    afterAll(async () => {
      await cleanupTestSandbox(sandbox);
      sandbox = null;
    }, 120000);
  });

  /**
   * Credential-less R2 egress mount: mountBucket is called with no endpoint,
   * so the SDK resolves the bucket via its R2 binding and routes s3fs traffic
   * through the outbound egress handler. This path previously had two bugs:
   * 1. setOutboundByHost('r2.internal', 'r2Mount') threw "not found" because
   *    the CF runtime couldn't find the handler name in outboundHandlers.
   * 2. s3fs exited with "could not determine security credentials" even with
   *    nosignrequest, because it validates credentials before applying that flag.
   * Both only surface at runtime against a real container + CF runtime.
   */
  describe('r2-egress', () => {
    let sandbox: TestSandbox | null = null;
    let workerUrl: string;
    let headers: Record<string, string>;

    const TEST_BUCKET = 'TEST_BUCKET';
    const MOUNT_PATH = '/mnt/r2-egress-test';
    const PRE_EXISTING_FILE = `r2-egress-pre-${Date.now()}.txt`;
    const PRE_EXISTING_CONTENT = 'Written to R2 before egress mount';
    const WRITTEN_FILE = `r2-egress-write-${Date.now()}.txt`;
    const WRITTEN_CONTENT = `Written via egress mount - ${new Date().toISOString()}`;

    beforeAll(async () => {
      sandbox = await createTestSandbox();
      workerUrl = sandbox.workerUrl;
      headers = sandbox.headers();
    }, 120000);

    test('should mount R2 binding without credentials and perform bidirectional file operations', async () => {
      try {
        // 1. Write a file to the R2 bucket via binding before mounting
        const putResponse = await fetch(`${workerUrl}/api/bucket/put`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            key: PRE_EXISTING_FILE,
            content: PRE_EXISTING_CONTENT,
            contentType: 'text/plain'
          })
        });
        expect(putResponse.ok).toBe(true);

        // 2. Mount via R2 binding — no endpoint means the egress handler path is used.
        //    This catches: outboundHandlers name-lookup errors, s3fs credential-check
        //    errors, and any other runtime failures specific to this mount path.
        const mountResponse = await fetch(`${workerUrl}/api/bucket/mount`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            bucket: TEST_BUCKET,
            mountPath: MOUNT_PATH,
            options: {}
          })
        });
        expect(mountResponse.ok).toBe(true);
        const mountResult = (await mountResponse.json()) as SuccessResponse;
        expect(mountResult.success).toBe(true);

        // 3. Verify the pre-existing R2 file is visible through the mount (R2 → container)
        const readResponse = await fetch(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: [
              '/bin/bash',
              '-lc',
              `cat ${MOUNT_PATH}/${PRE_EXISTING_FILE}`
            ]
          })
        });
        const readResult = (await readResponse.json()) as CommandResponse;
        expect(readResult.exitCode).toBe(0);
        expect(readResult.stdout?.trim()).toBe(PRE_EXISTING_CONTENT);

        // 4. Write a new file through the mount (container → R2)
        const writeResponse = await fetch(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: [
              '/bin/bash',
              '-lc',
              `echo "${WRITTEN_CONTENT}" > ${MOUNT_PATH}/${WRITTEN_FILE}`
            ]
          })
        });
        const writeResult = (await writeResponse.json()) as CommandResponse;
        expect(writeResult.exitCode).toBe(0);

        // 5. Verify the written file is visible in R2 via binding
        const getResponse = await fetch(
          `${workerUrl}/api/bucket/get?key=${WRITTEN_FILE}`,
          { method: 'GET', headers }
        );
        expect(getResponse.ok).toBe(true);
        const getResult = (await getResponse.json()) as BucketGetResponse;
        expect(getResult.success).toBe(true);
        expect(getResult.content.trim()).toBe(WRITTEN_CONTENT);

        // 6. Unmount
        const unmountResponse = await fetch(`${workerUrl}/api/bucket/unmount`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mountPath: MOUNT_PATH })
        });
        expect(unmountResponse.ok).toBe(true);
        const unmountResult =
          (await unmountResponse.json()) as BucketUnmountResponse;
        expect(unmountResult.success).toBe(true);

        // 7. Mount point should no longer be active
        const mountCheck = await fetch(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: ['/bin/bash', '-lc', `mountpoint -q ${MOUNT_PATH}`]
          })
        });
        const mountCheckResult = (await mountCheck.json()) as CommandResponse;
        expect(mountCheckResult.exitCode).not.toBe(0);
      } finally {
        // Cleanup: delete test files from R2
        await fetch(`${workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: PRE_EXISTING_FILE })
        }).catch(() => {});
        await fetch(`${workerUrl}/api/bucket/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: WRITTEN_FILE })
        }).catch(() => {});
      }
    }, 120000);

    afterAll(async () => {
      await cleanupTestSandbox(sandbox);
      sandbox = null;
    }, 120000);
  });
});
