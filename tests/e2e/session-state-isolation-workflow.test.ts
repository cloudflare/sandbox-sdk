import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';
import {
  createSandboxId,
  createTestHeaders,
  cleanupSandbox
} from './helpers/test-fixtures';
import type {
  Process,
  SessionCreateResult,
  SessionDeleteResult,
  ReadFileResult,
  ExecResult
} from '@repo/shared';

/**
 * Session State Isolation Workflow Integration Tests
 *
 * Tests session isolation features WITHIN a single container.
 * Sessions provide isolated shell state (env, cwd, functions) but share
 * file system and process space - that's by design!
 *
 * All tests share ONE container since we're testing session isolation,
 * not container isolation.
 */
describe('Session State Isolation Workflow', () => {
  describe('local', () => {
    let workerUrl: string;
    let sandboxId: string;
    let baseHeaders: Record<string, string>;

    beforeAll(async () => {
      // Create ONE sandbox for all session isolation tests
      const sandbox = await getSharedSandbox();
      workerUrl = sandbox.workerUrl;
      sandboxId = sandbox.sandboxId;
      baseHeaders = createTestHeaders(sandboxId, createUniqueSession());

      // Initialize the sandbox
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({
          command: 'echo "Session isolation sandbox ready"'
        })
      });
    }, 120000);

    test('should isolate environment variables between sessions', async () => {
      // Create session1 with production environment
      const session1Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          env: {
            NODE_ENV: 'production',
            API_KEY: 'prod-key-123',
            DB_HOST: 'prod.example.com'
          }
        })
      });

      expect(session1Response.status).toBe(200);
      const session1Data =
        (await session1Response.json()) as SessionCreateResult;
      expect(session1Data.success).toBe(true);
      expect(session1Data.sessionId).toBeTruthy();
      const session1Id = session1Data.sessionId;

      // Create session2 with test environment
      const session2Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          env: {
            NODE_ENV: 'test',
            API_KEY: 'test-key-456',
            DB_HOST: 'test.example.com'
          }
        })
      });

      expect(session2Response.status).toBe(200);
      const session2Data =
        (await session2Response.json()) as SessionCreateResult;
      expect(session2Data.sessionId).toBeTruthy();
      const session2Id = session2Data.sessionId;

      // Verify session1 has production environment
      const exec1Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'echo "$NODE_ENV|$API_KEY|$DB_HOST"'
        })
      });

      expect(exec1Response.status).toBe(200);
      const exec1Data = (await exec1Response.json()) as ExecResult;
      expect(exec1Data.success).toBe(true);
      expect(exec1Data.stdout.trim()).toBe(
        'production|prod-key-123|prod.example.com'
      );

      // Verify session2 has test environment
      const exec2Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'echo "$NODE_ENV|$API_KEY|$DB_HOST"'
        })
      });

      expect(exec2Response.status).toBe(200);
      const exec2Data = (await exec2Response.json()) as ExecResult;
      expect(exec2Data.success).toBe(true);
      expect(exec2Data.stdout.trim()).toBe(
        'test|test-key-456|test.example.com'
      );

      // Set NEW_VAR in session1 dynamically
      const setEnv1Response = await fetch(`${workerUrl}/api/env/set`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          envVars: { NEW_VAR: 'session1-only' }
        })
      });

      expect(setEnv1Response.status).toBe(200);

      // Verify NEW_VAR exists in session1
      const check1Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'echo $NEW_VAR'
        })
      });

      const check1Data = (await check1Response.json()) as ExecResult;
      expect(check1Data.stdout.trim()).toBe('session1-only');

      // Verify NEW_VAR does NOT leak to session2
      const check2Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'echo "VALUE:$NEW_VAR:END"'
        })
      });

      const check2Data = (await check2Response.json()) as ExecResult;
      expect(check2Data.stdout.trim()).toBe('VALUE::END'); // NEW_VAR should be empty
    }, 90000);

    test('should isolate working directories between sessions', async () => {
      // Create directory structure first (using default session)
      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          path: '/workspace/app',
          recursive: true
        })
      });

      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          path: '/workspace/test',
          recursive: true
        })
      });

      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          path: '/workspace/app/src',
          recursive: true
        })
      });

      await fetch(`${workerUrl}/api/file/mkdir`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          path: '/workspace/test/unit',
          recursive: true
        })
      });

      // Create session1 with cwd: /workspace/app
      const session1Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          cwd: '/workspace/app'
        })
      });

      const session1Data =
        (await session1Response.json()) as SessionCreateResult;
      const session1Id = session1Data.sessionId;

      // Create session2 with cwd: /workspace/test
      const session2Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          cwd: '/workspace/test'
        })
      });

      const session2Data =
        (await session2Response.json()) as SessionCreateResult;
      const session2Id = session2Data.sessionId;

      // Verify session1 starts in /workspace/app
      const pwd1Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'pwd'
        })
      });

      const pwd1Data = (await pwd1Response.json()) as ExecResult;
      expect(pwd1Data.stdout.trim()).toBe('/workspace/app');

      // Verify session2 starts in /workspace/test
      const pwd2Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'pwd'
        })
      });

      const pwd2Data = (await pwd2Response.json()) as ExecResult;
      expect(pwd2Data.stdout.trim()).toBe('/workspace/test');

      // Change directory in session1
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'cd src'
        })
      });

      // Change directory in session2
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'cd unit'
        })
      });

      // Verify session1 is in /workspace/app/src
      const newPwd1Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'pwd'
        })
      });

      const newPwd1Data = (await newPwd1Response.json()) as ExecResult;
      expect(newPwd1Data.stdout.trim()).toBe('/workspace/app/src');

      // Verify session2 is in /workspace/test/unit
      const newPwd2Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'pwd'
        })
      });

      const newPwd2Data = (await newPwd2Response.json()) as ExecResult;
      expect(newPwd2Data.stdout.trim()).toBe('/workspace/test/unit');
    }, 90000);

    test('should isolate shell state (functions and aliases) between sessions', async () => {
      // Create two sessions
      const session1Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({})
      });

      const session1Data =
        (await session1Response.json()) as SessionCreateResult;
      const session1Id = session1Data.sessionId;

      const session2Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({})
      });

      const session2Data =
        (await session2Response.json()) as SessionCreateResult;
      const session2Id = session2Data.sessionId;

      // Define greet() function in session1
      const defineFunc1Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'greet() { echo "Hello from Production"; }'
        })
      });

      expect(defineFunc1Response.status).toBe(200);

      // Call greet() in session1 - should work
      const call1Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'greet'
        })
      });

      const call1Data = (await call1Response.json()) as ExecResult;
      expect(call1Data.success).toBe(true);
      expect(call1Data.stdout.trim()).toBe('Hello from Production');

      // Try to call greet() in session2 - should fail
      const call2Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'greet'
        })
      });

      const call2Data = (await call2Response.json()) as ExecResult;
      expect(call2Data.success).toBe(false); // Function not found
      expect(call2Data.exitCode).not.toBe(0);

      // Define different greet() function in session2
      await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'greet() { echo "Hello from Test"; }'
        })
      });

      // Call greet() in session2 - should use session2's definition
      const call3Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'greet'
        })
      });

      const call3Data = (await call3Response.json()) as ExecResult;
      expect(call3Data.success).toBe(true);
      expect(call3Data.stdout.trim()).toBe('Hello from Test');

      // Verify session1's greet() is still unchanged
      const call4Response = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'greet'
        })
      });

      const call4Data = (await call4Response.json()) as ExecResult;
      expect(call4Data.stdout.trim()).toBe('Hello from Production');
    }, 90000);

    test('should share process space between sessions (by design)', async () => {
      // Create two sessions
      const session1Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({})
      });

      const session1Data =
        (await session1Response.json()) as SessionCreateResult;
      const session1Id = session1Data.sessionId;

      const session2Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({})
      });

      const session2Data =
        (await session2Response.json()) as SessionCreateResult;
      const session2Id = session2Data.sessionId;

      // Start a long-running process in session1
      const startResponse = await fetch(`${workerUrl}/api/process/start`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'sleep 120'
        })
      });

      expect(startResponse.status).toBe(200);
      const startData = (await startResponse.json()) as Process;
      const processId = startData.id;

      // Wait for process to be registered
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // List processes from session2 - should see session1's process (shared process table)
      const listResponse = await fetch(`${workerUrl}/api/process/list`, {
        method: 'GET',
        headers: createTestHeaders(sandboxId, session2Id)
      });

      expect(listResponse.status).toBe(200);
      const listData = (await listResponse.json()) as Process[];
      const processes = listData;
      expect(Array.isArray(processes)).toBe(true);

      // Find our process in the list
      const ourProcess = processes.find((p) => p.id === processId);
      expect(ourProcess).toBeTruthy();
      if (!ourProcess) throw new Error('Process not found');

      expect(ourProcess.status).toBe('running');

      // Kill the process from session2 - should work (shared process table)
      const killResponse = await fetch(
        `${workerUrl}/api/process/${processId}`,
        {
          method: 'DELETE',
          headers: createTestHeaders(sandboxId, session2Id)
        }
      );

      expect(killResponse.status).toBe(200);

      // Verify process is killed (check from session1)
      await new Promise((resolve) => setTimeout(resolve, 500));

      const verifyResponse = await fetch(
        `${workerUrl}/api/process/${processId}`,
        {
          method: 'GET',
          headers: createTestHeaders(sandboxId, session1Id)
        }
      );

      const verifyData = (await verifyResponse.json()) as Process;
      expect(verifyData.status).not.toBe('running');
    }, 90000);

    test('should share file system between sessions (by design)', async () => {
      // Create two sessions
      const session1Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({})
      });

      const session1Data =
        (await session1Response.json()) as SessionCreateResult;
      const session1Id = session1Data.sessionId;

      const session2Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({})
      });

      const session2Data =
        (await session2Response.json()) as SessionCreateResult;
      const session2Id = session2Data.sessionId;

      // Write a file from session1
      const writeResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          path: '/workspace/shared.txt',
          content: 'Written by session1'
        })
      });

      expect(writeResponse.status).toBe(200);

      // Read the file from session2 - should see session1's content
      const readResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          path: '/workspace/shared.txt'
        })
      });

      expect(readResponse.status).toBe(200);
      const readData = (await readResponse.json()) as ReadFileResult;
      expect(readData.content).toBe('Written by session1');

      // Modify the file from session2
      const modifyResponse = await fetch(`${workerUrl}/api/file/write`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          path: '/workspace/shared.txt',
          content: 'Modified by session2'
        })
      });

      expect(modifyResponse.status).toBe(200);

      // Read from session1 - should see session2's modification
      const verifyResponse = await fetch(`${workerUrl}/api/file/read`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          path: '/workspace/shared.txt'
        })
      });

      const verifyData = (await verifyResponse.json()) as ReadFileResult;
      expect(verifyData.content).toBe('Modified by session2');

      // Cleanup
      await fetch(`${workerUrl}/api/file/delete`, {
        method: 'DELETE',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          path: '/workspace/shared.txt'
        })
      });
    }, 90000);

    test('should support concurrent execution without output mixing', async () => {
      // Create two sessions
      const session1Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          env: { SESSION_NAME: 'session1' }
        })
      });

      const session1Data =
        (await session1Response.json()) as SessionCreateResult;
      const session1Id = session1Data.sessionId;

      const session2Response = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          env: { SESSION_NAME: 'session2' }
        })
      });

      const session2Data =
        (await session2Response.json()) as SessionCreateResult;
      const session2Id = session2Data.sessionId;

      // Execute commands simultaneously
      const exec1Promise = fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session1Id),
        body: JSON.stringify({
          command: 'sleep 2 && echo "Completed in $SESSION_NAME"'
        })
      });

      const exec2Promise = fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, session2Id),
        body: JSON.stringify({
          command: 'sleep 2 && echo "Completed in $SESSION_NAME"'
        })
      });

      // Wait for both to complete
      const [exec1Response, exec2Response] = await Promise.all([
        exec1Promise,
        exec2Promise
      ]);

      // Verify both succeeded
      expect(exec1Response.status).toBe(200);
      expect(exec2Response.status).toBe(200);

      const exec1Data = (await exec1Response.json()) as ExecResult;
      const exec2Data = (await exec2Response.json()) as ExecResult;

      // Verify correct output (no mixing)
      expect(exec1Data.success).toBe(true);
      expect(exec1Data.stdout.trim()).toBe('Completed in session1');

      expect(exec2Data.success).toBe(true);
      expect(exec2Data.stdout.trim()).toBe('Completed in session2');
    }, 90000);

    test('should serialize concurrent requests to the same session', async () => {
      // Fire multiple concurrent requests to the SAME session
      // Without proper locking, outputs would interleave
      const requests = Array(3)
        .fill(null)
        .map((_, i) =>
          fetch(`${workerUrl}/api/execute`, {
            method: 'POST',
            headers: baseHeaders,
            body: JSON.stringify({
              command: `echo "START-${i}"; sleep 0.1; echo "END-${i}"`
            })
          }).then((res) => res.json() as Promise<ExecResult>)
        );

      const results = await Promise.all(requests);

      // All should succeed
      for (const result of results) {
        expect(result.exitCode).toBe(0);
      }

      // Each result should have its own complete START/END pair (not interleaved)
      for (const result of results) {
        const stdout = result.stdout;
        const startMatch = stdout.match(/START-(\d)/);
        expect(startMatch).toBeTruthy();
        if (startMatch) {
          const cmdNum = startMatch[1];
          expect(stdout).toContain(`END-${cmdNum}`);
        }
      }
    }, 90000);

    test('should properly cleanup session resources with deleteSession', async () => {
      // Create a session with custom environment variable
      const sessionResponse = await fetch(`${workerUrl}/api/session/create`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          env: { SESSION_VAR: 'test-value' }
        })
      });

      expect(sessionResponse.status).toBe(200);
      const sessionData = (await sessionResponse.json()) as SessionCreateResult;
      const sessionId = sessionData.sessionId;

      // Verify session works before deletion
      const execBeforeResponse = await fetch(`${workerUrl}/api/execute`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId, sessionId),
        body: JSON.stringify({
          command: 'echo $SESSION_VAR'
        })
      });

      expect(execBeforeResponse.status).toBe(200);
      const execBeforeData = (await execBeforeResponse.json()) as ExecResult;
      expect(execBeforeData.stdout.trim()).toBe('test-value');

      // Delete the session
      const deleteResponse = await fetch(`${workerUrl}/api/session/delete`, {
        method: 'POST',
        headers: createTestHeaders(sandboxId!),
        body: JSON.stringify({
          sessionId: sessionId
        })
      });

      expect(deleteResponse.status).toBe(200);
      const deleteData = (await deleteResponse.json()) as SessionDeleteResult;
      expect(deleteData.success).toBe(true);
      expect(deleteData.sessionId).toBe(sessionId);
      expect(deleteData.timestamp).toBeTruthy();

      // Verify the deleted session's state is gone
      // Note: Container auto-creates sessions on first use, so this succeeds
      // but we should verify the custom environment variable is gone
      const useDeletedSessionResponse = await fetch(
        `${workerUrl}/api/execute`,
        {
          method: 'POST',
          headers: createTestHeaders(sandboxId, sessionId), // Use same session ID
          body: JSON.stringify({
            command: 'echo $SESSION_VAR'
          })
        }
      );

      expect(useDeletedSessionResponse.status).toBe(200);
      const recreatedSessionData =
        (await useDeletedSessionResponse.json()) as ExecResult;
      expect(recreatedSessionData.success).toBe(true);
      // Session state should be gone - SESSION_VAR should be empty (fresh session)
      expect(recreatedSessionData.stdout.trim()).toBe('');

      // Verify we can still use the sandbox (it wasn't destroyed)
      const sandboxStillAliveResponse = await fetch(
        `${workerUrl}/api/execute`,
        {
          method: 'POST',
          headers: createTestHeaders(sandboxId!), // Use default session
          body: JSON.stringify({
            command: 'echo "sandbox-alive"'
          })
        }
      );

      expect(sandboxStillAliveResponse.status).toBe(200);
      const sandboxAliveData =
        (await sandboxStillAliveResponse.json()) as ExecResult;
      expect(sandboxAliveData.success).toBe(true);
      expect(sandboxAliveData.stdout.trim()).toBe('sandbox-alive');
    }, 90000);
  });
});
