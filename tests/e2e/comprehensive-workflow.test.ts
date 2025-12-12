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

import type {
  EnvSetResult,
  ExecEvent,
  ExecResult,
  FileInfo,
  GitCheckoutResult,
  ListFilesResult,
  MkdirResult,
  Process,
  ProcessLogsResult,
  ReadFileResult,
  WriteFileResult
} from '@repo/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import { parseSSEStream } from '../../packages/sandbox/src/sse-parser';
import {
  createUniqueSession,
  getSharedSandbox,
  uniqueTestPath
} from './helpers/global-sandbox';

describe('Comprehensive Workflow', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    // Use the shared sandbox with a unique session for this test file
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  /**
   * Test 1: Complete Developer Workflow
   *
   * Simulates a realistic workflow:
   * 1. Clone a repository
   * 2. Set up environment variables
   * 3. Explore and modify files
   * 4. Run commands with environment
   * 5. Start a background process
   * 6. Monitor via streaming
   * 7. Clean up
   */
  test('should execute complete developer workflow: clone → env → files → process', async () => {
    // ========================================
    // Phase 1: Clone a repository
    // ========================================
    const testDir = uniqueTestPath('hello-world');
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

    // ========================================
    // Phase 2: Set up environment variables
    // ========================================
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

    expect(setEnvResponse.status).toBe(200);
    const envData = (await setEnvResponse.json()) as EnvSetResult;
    expect(envData.success).toBe(true);

    // Verify env vars are available
    const envCheckResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "$PROJECT_NAME|$BUILD_ENV|$API_KEY"'
      })
    });

    expect(envCheckResponse.status).toBe(200);
    const envCheckData = (await envCheckResponse.json()) as ExecResult;
    expect(envCheckData.stdout.trim()).toBe('hello-world|test|test-key-123');

    // ========================================
    // Phase 3: File operations on cloned repo
    // ========================================

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

    // ========================================
    // Phase 4: Run commands with environment
    // ========================================

    // Use env vars in a command
    const buildResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `echo "Building $PROJECT_NAME in $BUILD_ENV mode" && ls -la ${testDir}/src`,
        cwd: testDir
      })
    });

    expect(buildResponse.status).toBe(200);
    const buildData = (await buildResponse.json()) as ExecResult;
    expect(buildData.stdout).toContain('Building hello-world in test mode');
    expect(buildData.stdout).toContain('utils');

    // Run git status to verify we're in a git repo
    const gitStatusResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'git status --porcelain',
        cwd: testDir
      })
    });

    expect(gitStatusResponse.status).toBe(200);
    const gitStatusData = (await gitStatusResponse.json()) as ExecResult;
    // Should show our new files as untracked
    expect(gitStatusData.stdout).toContain('config.json');
    expect(gitStatusData.stdout).toContain('src/');

    // ========================================
    // Phase 5: Background process with streaming
    // ========================================

    // Write a simple server script that uses env vars
    const serverScript = `
const port = 8888;
console.log(\`[Server] Starting on port \${port}\`);
console.log(\`[Server] PROJECT_NAME = \${process.env.PROJECT_NAME}\`);
console.log(\`[Server] BUILD_ENV = \${process.env.BUILD_ENV}\`);

let counter = 0;
const interval = setInterval(() => {
  counter++;
  console.log(\`[Server] Heartbeat \${counter}\`);
  if (counter >= 3) {
    clearInterval(interval);
    console.log('[Server] Done');
    process.exit(0);
  }
}, 500);
`.trim();

    await fetch(`${workerUrl}/api/file/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: `${testDir}/server.js`,
        content: serverScript
      })
    });

    // Start the background process
    const startResponse = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `bun run ${testDir}/server.js`
      })
    });

    expect(startResponse.status).toBe(200);
    const processData = (await startResponse.json()) as Process;
    expect(processData.id).toBeTruthy();
    const processId = processData.id;

    // Wait for process to complete using waitForLog instead of fixed sleep
    // This is more reliable under load as it waits for actual output
    const waitResponse = await fetch(
      `${workerUrl}/api/process/${processId}/waitForLog`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          pattern: 'Done',
          timeout: 10000
        })
      }
    );
    expect(waitResponse.status).toBe(200);

    // Get process logs
    const logsResponse = await fetch(
      `${workerUrl}/api/process/${processId}/logs`,
      {
        method: 'GET',
        headers
      }
    );

    expect(logsResponse.status).toBe(200);
    const logsData = (await logsResponse.json()) as ProcessLogsResult;

    // Verify env vars were available to the process
    expect(logsData.stdout).toContain('PROJECT_NAME = hello-world');
    expect(logsData.stdout).toContain('BUILD_ENV = test');
    expect(logsData.stdout).toContain('Heartbeat 3');
    expect(logsData.stdout).toContain('Done');

    // ========================================
    // Phase 6: Cleanup - move and delete files
    // ========================================

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
    const fileNames = finalListData.files.map((f: FileInfo) => f.relativePath);
    expect(fileNames).toContain('backup/config.json');
    expect(fileNames).not.toContain('server.js');
    expect(fileNames).toContain('src/utils/greeter.js');
  }, 180000);

  /**
   * Test 2: Streaming execution with real-time output
   *
   * Tests execStream to verify SSE streaming works correctly
   * within the same sandbox context.
   */
  test('should stream command output in real-time', async () => {
    // Helper to collect SSE events
    async function collectSSEEvents(
      response: Response,
      maxEvents: number = 50
    ): Promise<ExecEvent[]> {
      if (!response.body) throw new Error('No body');

      const events: ExecEvent[] = [];
      const abortController = new AbortController();

      try {
        for await (const event of parseSSEStream<ExecEvent>(
          response.body,
          abortController.signal
        )) {
          events.push(event);
          if (event.type === 'complete' || event.type === 'error') {
            abortController.abort();
            break;
          }
          if (events.length >= maxEvents) {
            abortController.abort();
            break;
          }
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message !== 'Operation was aborted'
        ) {
          throw error;
        }
      }

      return events;
    }

    // Stream a command that outputs multiple lines with timestamps
    const streamResponse = await fetch(`${workerUrl}/api/execStream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command:
          'for i in 1 2 3; do echo "[$PROJECT_NAME] Step $i at $(date +%s)"; sleep 0.3; done'
      })
    });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toBe(
      'text/event-stream'
    );

    const events = await collectSSEEvents(streamResponse);

    // Verify event types
    const eventTypes = new Set(events.map((e) => e.type));
    expect(eventTypes.has('start')).toBe(true);
    expect(eventTypes.has('stdout')).toBe(true);
    expect(eventTypes.has('complete')).toBe(true);

    // Verify output includes env var from earlier phase
    const output = events
      .filter((e) => e.type === 'stdout')
      .map((e) => e.data)
      .join('');
    expect(output).toContain('[hello-world]');
    expect(output).toContain('Step 1');
    expect(output).toContain('Step 3');

    // Verify successful completion
    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent?.exitCode).toBe(0);
  }, 60000);

  /**
   * Test 3: Per-command env and cwd without mutating session
   *
   * Verifies that per-command options work correctly and
   * don't affect the session state.
   */
  test('should support per-command env and cwd without affecting session', async () => {
    // Execute with per-command env
    const cmdEnvResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "TEMP=$TEMP_VAR, PROJECT=$PROJECT_NAME"',
        env: { TEMP_VAR: 'temporary-value' }
      })
    });

    expect(cmdEnvResponse.status).toBe(200);
    const cmdEnvData = (await cmdEnvResponse.json()) as ExecResult;
    // Should have both per-command env AND session env
    expect(cmdEnvData.stdout.trim()).toBe(
      'TEMP=temporary-value, PROJECT=hello-world'
    );

    // Verify TEMP_VAR didn't persist to session
    const verifyEnvResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'echo "TEMP=$TEMP_VAR"'
      })
    });

    const verifyEnvData = (await verifyEnvResponse.json()) as ExecResult;
    expect(verifyEnvData.stdout.trim()).toBe('TEMP=');

    // Execute with per-command cwd
    const cmdCwdResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'pwd',
        cwd: '/tmp'
      })
    });

    expect(cmdCwdResponse.status).toBe(200);
    const cmdCwdData = (await cmdCwdResponse.json()) as ExecResult;
    expect(cmdCwdData.stdout.trim()).toBe('/tmp');

    // Verify session cwd wasn't changed
    const verifyCwdResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'pwd'
      })
    });

    const verifyCwdData = (await verifyCwdResponse.json()) as ExecResult;
    expect(verifyCwdData.stdout.trim()).toBe('/workspace');
  }, 60000);

  /**
   * Test 4: Binary file handling
   *
   * Tests reading and writing binary files.
   */
  test('should handle binary file operations', async () => {
    // Create a binary file using base64
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jYlkKQAAAABJRU5ErkJggg==';

    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: `echo '${pngBase64}' | base64 -d > /workspace/test-image.png`
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
  }, 60000);

  /**
   * Test 5: Process list and management
   *
   * Tests starting multiple processes and listing them.
   */
  test('should manage multiple background processes', async () => {
    // Start two background processes
    const process1Response = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'sleep 30' })
    });
    const process1 = (await process1Response.json()) as Process;

    const process2Response = await fetch(`${workerUrl}/api/process/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'sleep 30' })
    });
    const process2 = (await process2Response.json()) as Process;

    // Wait for processes to be registered
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // List all processes
    const listResponse = await fetch(`${workerUrl}/api/process/list`, {
      method: 'GET',
      headers
    });

    expect(listResponse.status).toBe(200);
    const processList = (await listResponse.json()) as Process[];

    expect(processList.length).toBeGreaterThanOrEqual(2);
    const ids = processList.map((p) => p.id);
    expect(ids).toContain(process1.id);
    expect(ids).toContain(process2.id);

    // Kill all processes
    const killAllResponse = await fetch(`${workerUrl}/api/process/kill-all`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });

    expect(killAllResponse.status).toBe(200);

    // Poll until no running processes remain (up to 5 seconds)
    let running: Process[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const listAfterResponse = await fetch(`${workerUrl}/api/process/list`, {
        method: 'GET',
        headers
      });
      const processesAfter = (await listAfterResponse.json()) as Process[];
      running = processesAfter.filter((p) => p.status === 'running');
      if (running.length === 0) break;
    }
    expect(running.length).toBe(0);
  }, 60000);
});
