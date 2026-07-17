/**
 * Comprehensive Workflow Integration Test
 *
 * This test validates a realistic end-to-end workflow using a SINGLE sandbox,
 * combining features that were previously tested in isolation:
 * - Git clone
 * - Environment variables
 * - File operations (read, write, mkdir, rename, move, delete)
 * - Command execution
 * - Background process management
 * - Streaming output
 *
 * By testing features together in one sandbox, we:
 * 1. Reduce test runtime (one container vs many)
 * 2. Test realistic usage patterns
 * 3. Catch integration issues between features
 *
 * Individual edge cases and error handling remain in dedicated test files.
 */

import type { GitCheckoutResult } from '@cloudflare/sandbox/git';
import type { FileInfo, ListFilesResult, ReadFileResult } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CommandResponse } from './command-response';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

describe('Comprehensive Workflow', () => {
  let sandbox: TestSandbox | null = null;
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    // Create isolated sandbox for this test file
    sandbox = await createTestSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.headers();

    // Env vars live here (not in test 1) so tests 2-3 pass even if the clone fails.
    const setEnvResponse = await fetch(`${workerUrl}/api/env/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        envVars: {
          PROJECT_NAME: 'hello-world',
          BUILD_ENV: 'test',
          API_KEY: 'test-key-123'
        }
      })
    });

    if (!setEnvResponse.ok) {
      throw new Error(`Failed to set env vars: ${setEnvResponse.status}`);
    }
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  /**
   * Test 1: Complete Developer Workflow
   *
   * Simulates a realistic workflow:
   * 1. Clone a repository
   * 2. Explore and modify files
   * 3. Run commands with environment
   * 4. Start a background process and monitor via streaming
   * 5. Clean up
   */
  test(
    'should execute complete developer workflow: clone → env → files → process',
    { retry: 2, timeout: 180000 },
    async () => {
      // Phase 1: Clone a repository
      const testDir = sandbox!.uniquePath('hello-world');
      const cloneResponse = await fetch(`${workerUrl}/api/git/clone`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repoUrl: 'https://github.com/octocat/Hello-World',
          branch: 'master',
          targetDir: testDir
        })
      });

      expect(cloneResponse.status).toBe(200);
      const cloneData = (await cloneResponse.json()) as GitCheckoutResult;
      expect(cloneData.success).toBe(true);

      // Verify repo structure using listFiles
      const listResponse = await fetch(`${workerUrl}/api/list-files`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: testDir })
      });

      expect(listResponse.status).toBe(200);
      const listData = (await listResponse.json()) as ListFilesResult;
      expect(listData.files.some((f: FileInfo) => f.name === 'README')).toBe(
        true
      );

      // Phase 2: File operations on cloned repo

      // Read the README from cloned repo
      const readReadmeResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: `${testDir}/README` })
      });

      expect(readReadmeResponse.status).toBe(200);
      const readmeData = (await readReadmeResponse.json()) as ReadFileResult;
      expect(readmeData.content).toContain('Hello');

      // Create a new directory structure
      const mkdirResponse = await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: `${testDir}/src/utils`,
          recursive: true
        })
      });

      expect(mkdirResponse.status).toBe(200);

      // Write a config file using env vars in filename generation
      const configContent = JSON.stringify(
        {
          name: 'hello-world',
          env: 'test',
          version: '1.0.0'
        },
        null,
        2
      );

      const writeConfigResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: `${testDir}/config.json`,
          content: configContent
        })
      });

      expect(writeConfigResponse.status).toBe(200);

      // Write a source file
      const sourceCode = `
// Generated file using env: $BUILD_ENV
export function greet(name) {
  return \`Hello, \${name}!\`;
}
`.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: `${testDir}/src/utils/greet.js`,
          content: sourceCode
        })
      });

      // Rename the file
      const renameResponse = await fetch(`${workerUrl}/api/file/rename`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          oldPath: `${testDir}/src/utils/greet.js`,
          newPath: `${testDir}/src/utils/greeter.js`
        })
      });

      expect(renameResponse.status).toBe(200);

      // Verify rename worked by reading new path
      const readRenamedResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: `${testDir}/src/utils/greeter.js`
        })
      });

      expect(readRenamedResponse.status).toBe(200);
      const renamedData = (await readRenamedResponse.json()) as ReadFileResult;
      expect(renamedData.content).toContain('greet');

      // Phase 3: Run commands with environment

      // Use env vars in a command
      const buildResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: [
            '/bin/bash',
            '-lc',
            `echo "Building $PROJECT_NAME in $BUILD_ENV mode" && ls -la ${testDir}/src`
          ],
          cwd: testDir
        })
      });

      expect(buildResponse.status).toBe(200);
      const buildData = (await buildResponse.json()) as CommandResponse;
      expect(buildData.stdout).toContain('Building hello-world in test mode');
      expect(buildData.stdout).toContain('utils');

      // Run git status to verify we're in a git repo
      const gitStatusResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'git status --porcelain'],
          cwd: testDir
        })
      });

      expect(gitStatusResponse.status).toBe(200);
      const gitStatusData = (await gitStatusResponse.json()) as CommandResponse;
      // Should show our new files as untracked
      expect(gitStatusData.stdout).toContain('config.json');
      expect(gitStatusData.stdout).toContain('src/');

      // Phase 4: Background process and Port readiness

      // Write a simple server script that uses env vars
      const serverScript = `
const server = Bun.serve({
  port: 8888,
  fetch(req) {
    return new Response(\`PROJECT_NAME=\${process.env.PROJECT_NAME} BUILD_ENV=\${process.env.BUILD_ENV}\`);
  },
});
console.log("Server listening");
`.trim();

      await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: `${testDir}/server.js`,
          content: serverScript
        })
      });

      // Start the background process and wait for port
      const startResponse = await fetch(
        `${workerUrl}/api/exec-and-wait-for-port`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            command: ['/bin/bash', '-lc', `bun run ${testDir}/server.js`],
            port: 8888
          })
        }
      );

      expect(startResponse.status).toBe(200);

      // Verify server is responding with correct env vars
      const queryResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'curl -s http://localhost:8888']
        })
      });

      expect(queryResponse.status).toBe(200);
      const queryResult = (await queryResponse.json()) as CommandResponse;
      expect(queryResult.stdout).toContain('PROJECT_NAME=hello-world');
      expect(queryResult.stdout).toContain('BUILD_ENV=test');

      // Phase 5: Cleanup - move and delete files

      // Move config to a backup location
      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: `${testDir}/backup`,
          recursive: true
        })
      });

      const moveResponse = await fetch(`${workerUrl}/api/file/move`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sourcePath: `${testDir}/config.json`,
          destinationPath: `${testDir}/backup/config.json`
        })
      });

      expect(moveResponse.status).toBe(200);

      // Delete the server script
      const deleteResponse = await fetch(`${workerUrl}/api/file/delete`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({
          path: `${testDir}/server.js`
        })
      });

      expect(deleteResponse.status).toBe(200);

      // Verify final state
      const finalListResponse = await fetch(`${workerUrl}/api/list-files`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: testDir,
          options: { recursive: true }
        })
      });

      expect(finalListResponse.status).toBe(200);
      const finalListData = (await finalListResponse.json()) as ListFilesResult;

      // Should have backup/config.json but not server.js at root
      const fileNames = finalListData.files.map(
        (f: FileInfo) => f.relativePath
      );
      expect(fileNames).toContain('backup/config.json');
      expect(fileNames).not.toContain('server.js');
      expect(fileNames).toContain('src/utils/greeter.js');
    }
  );

  /**
   * Test 3: Per-command env and cwd without mutating sandbox state
   *
   * Verifies that per-command options work correctly and
   * don't affect sandbox state.
   */
  test(
    'should support per-command env and cwd without affecting sandbox state',
    { retry: 2, timeout: 60000 },
    async () => {
      // Execute with per-command env
      const cmdEnvResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: [
            '/bin/bash',
            '-lc',
            'echo "TEMP=$TEMP_VAR, PROJECT=$PROJECT_NAME"'
          ],
          env: { TEMP_VAR: 'temporary-value' }
        })
      });

      expect(cmdEnvResponse.status).toBe(200);
      const cmdEnvData = (await cmdEnvResponse.json()) as CommandResponse;
      // Should have both per-command env AND sandbox env
      expect(cmdEnvData.stdout.trim()).toBe(
        'TEMP=temporary-value, PROJECT=hello-world'
      );

      // Verify TEMP_VAR didn't persist to sandbox state
      const verifyEnvResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'echo "TEMP=$TEMP_VAR"']
        })
      });

      const verifyEnvData = (await verifyEnvResponse.json()) as CommandResponse;
      expect(verifyEnvData.stdout.trim()).toBe('TEMP=');

      // Execute with per-command cwd
      const cmdCwdResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'pwd'],
          cwd: '/tmp'
        })
      });

      expect(cmdCwdResponse.status).toBe(200);
      const cmdCwdData = (await cmdCwdResponse.json()) as CommandResponse;
      expect(cmdCwdData.stdout.trim()).toBe('/tmp');

      // Verify sandbox cwd wasn't changed
      const verifyCwdResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: ['/bin/bash', '-lc', 'pwd']
        })
      });

      const verifyCwdData = (await verifyCwdResponse.json()) as CommandResponse;
      expect(verifyCwdData.stdout.trim()).toBe('/workspace');
    }
  );

  /**
   * Test 4: Binary file handling
   *
   * Tests reading and writing binary files.
   */
  test(
    'should handle binary file operations',
    { retry: 2, timeout: 60000 },
    async () => {
      // Create a binary file using base64
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jYlkKQAAAABJRU5ErkJggg==';

      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command: [
            '/bin/bash',
            '-lc',
            `echo '${pngBase64}' | base64 -d > /workspace/test-image.png`
          ]
        })
      });

      // Read the binary file
      const readBinaryResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: '/workspace/test-image.png'
        })
      });

      expect(readBinaryResponse.status).toBe(200);
      const binaryData = (await readBinaryResponse.json()) as ReadFileResult;

      expect(binaryData.isBinary).toBe(true);
      expect(binaryData.encoding).toBe('base64');
      expect(binaryData.mimeType).toMatch(/image\/png/);
      expect(binaryData.content).toBeTruthy();

      // Clean up
      await fetch(`${workerUrl}/api/file/delete`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ path: '/workspace/test-image.png' })
      });
    }
  );
});
