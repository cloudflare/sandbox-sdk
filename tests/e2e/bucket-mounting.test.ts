import type { ExecResult } from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';
import type { BucketGetResponse, SuccessResponse } from './test-worker/types';

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
    let workerUrl: string;
    let headers: Record<string, string>;

    const TEST_BUCKET = 'sandbox-e2e-test';
    const MOUNT_PATH = '/mnt/test-data';
    const TEST_FILE = `e2e-test-${Date.now()}.txt`;
    const TEST_CONTENT = `Bucket mounting E2E test - ${new Date().toISOString()}`;

    beforeAll(async () => {
      const sandbox = await getSharedSandbox();
      workerUrl = sandbox.workerUrl;
      headers = sandbox.createHeaders(createUniqueSession());
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

        // 2. Mount the bucket (no vi.waitFor - let BaseHttpClient handle retries)
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
              command: `cat ${MOUNT_PATH}/${PRE_EXISTING_FILE}`
            })
          }
        );
        const readPreExistingResult =
          (await readPreExistingResponse.json()) as ExecResult;
        expect(readPreExistingResult.exitCode).toBe(0);
        expect(readPreExistingResult.stdout?.trim()).toBe(PRE_EXISTING_CONTENT);

        // 4. Write new file via mount
        const writeResponse = await fetch(`${workerUrl}/api/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: `echo "${TEST_CONTENT}" > ${MOUNT_PATH}/${TEST_FILE}`
          })
        });
        const writeResult = (await writeResponse.json()) as ExecResult;
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

        // 6. Cleanup: delete both test files from R2
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
  });
});
