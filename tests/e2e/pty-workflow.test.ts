import { beforeAll, describe, expect, test } from 'vitest';
import {
  createUniqueSession,
  getSharedSandbox
} from './helpers/global-sandbox';

/**
 * PTY (Pseudo-Terminal) Workflow Tests
 *
 * Tests the PTY API endpoints for interactive terminal sessions:
 * - Create PTY session
 * - List PTY sessions
 * - Get PTY info
 * - Send input via HTTP (fallback)
 * - Resize PTY via HTTP (fallback)
 * - Kill PTY session
 *
 * Note: Real-time input/output via WebSocket is tested separately.
 * These tests focus on the HTTP API for PTY management.
 */
describe('PTY Workflow', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  test('PTY sanity check - container has PTY support', async () => {
    // Verify /dev/ptmx and /dev/pts exist in the container
    const checkResponse = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command:
          'ls -l /dev/ptmx && ls -ld /dev/pts && mount | grep devpts || echo "devpts not mounted"'
      })
    });

    expect(checkResponse.status).toBe(200);
    const checkData = (await checkResponse.json()) as {
      success: boolean;
      stdout: string;
      stderr: string;
    };

    console.log('[PTY Sanity Check] stdout:', checkData.stdout);
    console.log('[PTY Sanity Check] stderr:', checkData.stderr);

    // /dev/ptmx should exist for PTY allocation
    expect(checkData.stdout).toContain('/dev/ptmx');
  }, 30000);

  test('should create a PTY session', async () => {
    // Use /bin/sh and /tmp for reliable PTY creation
    const response = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/sh'], cwd: '/tmp' })
    });

    // Log response for debugging if it fails
    if (response.status !== 200) {
      const errorText = await response.text();
      console.error(
        '[PTY Create] Failed with status:',
        response.status,
        'body:',
        errorText
      );
    }

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      success: boolean;
      pty: {
        id: string;
        cols: number;
        rows: number;
        command: string[];
        state: string;
      };
      error?: string;
    };

    console.log('[PTY Create] Response:', JSON.stringify(data, null, 2));

    expect(data.success).toBe(true);
    expect(data.pty.id).toMatch(/^pty_/);
    expect(data.pty.cols).toBe(80);
    expect(data.pty.rows).toBe(24);
    expect(data.pty.command).toEqual(['/bin/sh']);
    expect(data.pty.state).toBe('running');

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${data.pty.id}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should create a PTY session with custom options', async () => {
    const response = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cols: 120,
        rows: 40,
        command: ['sh'],
        cwd: '/tmp'
      })
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      success: boolean;
      pty: {
        id: string;
        cols: number;
        rows: number;
        command: string[];
        cwd: string;
      };
    };

    expect(data.success).toBe(true);
    expect(data.pty.cols).toBe(120);
    expect(data.pty.rows).toBe(40);
    expect(data.pty.command).toEqual(['sh']);
    expect(data.pty.cwd).toBe('/tmp');

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${data.pty.id}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should list all PTY sessions', async () => {
    // Create two PTYs with explicit shell command
    const pty1Response = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cols: 80,
        rows: 24,
        command: ['/bin/sh'],
        cwd: '/tmp'
      })
    });
    const pty1 = (await pty1Response.json()) as { pty: { id: string } };

    const pty2Response = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        command: ['/bin/sh'],
        cwd: '/tmp'
      })
    });
    const pty2 = (await pty2Response.json()) as { pty: { id: string } };

    // List all PTYs
    const listResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'GET',
      headers
    });

    expect(listResponse.status).toBe(200);
    const listData = (await listResponse.json()) as {
      success: boolean;
      ptys: Array<{ id: string }>;
    };

    expect(listData.success).toBe(true);
    expect(listData.ptys.length).toBeGreaterThanOrEqual(2);
    expect(listData.ptys.some((p) => p.id === pty1.pty.id)).toBe(true);
    expect(listData.ptys.some((p) => p.id === pty2.pty.id)).toBe(true);

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${pty1.pty.id}`, {
      method: 'DELETE',
      headers
    });
    await fetch(`${workerUrl}/api/pty/${pty2.pty.id}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should get PTY info by ID', async () => {
    // Create a PTY with explicit shell command
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cols: 100,
        rows: 50,
        command: ['/bin/sh'],
        cwd: '/tmp'
      })
    });
    const createData = (await createResponse.json()) as {
      pty: { id: string };
    };

    // Get PTY info
    const getResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}`,
      {
        method: 'GET',
        headers
      }
    );

    expect(getResponse.status).toBe(200);
    const getData = (await getResponse.json()) as {
      success: boolean;
      pty: { id: string; cols: number; rows: number };
    };

    expect(getData.success).toBe(true);
    expect(getData.pty.id).toBe(createData.pty.id);
    expect(getData.pty.cols).toBe(100);
    expect(getData.pty.rows).toBe(50);

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${createData.pty.id}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should return error for nonexistent PTY', async () => {
    const response = await fetch(`${workerUrl}/api/pty/pty_nonexistent_12345`, {
      method: 'GET',
      headers
    });

    expect(response.status).toBe(500);
    const data = (await response.json()) as { error: string };
    expect(data.error).toMatch(/not found/i);
  }, 90000);

  test('should resize PTY via HTTP endpoint', async () => {
    // Create a PTY with explicit shell command and working directory
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cols: 80,
        rows: 24,
        command: ['/bin/sh'],
        cwd: '/tmp'
      })
    });
    const createData = (await createResponse.json()) as {
      pty: { id: string; state: string; exitCode?: number };
    };
    console.log(
      '[Test] PTY created:',
      createData.pty.id,
      'state:',
      createData.pty.state,
      'exitCode:',
      createData.pty.exitCode
    );

    // Small delay to let PTY initialize
    await new Promise((r) => setTimeout(r, 100));

    // Resize via HTTP
    const resizeResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}/resize`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ cols: 120, rows: 40 })
      }
    );

    expect(resizeResponse.status).toBe(200);
    const resizeData = (await resizeResponse.json()) as {
      success: boolean;
      cols: number;
      rows: number;
    };

    expect(resizeData.success).toBe(true);
    expect(resizeData.cols).toBe(120);
    expect(resizeData.rows).toBe(40);

    // Verify via get
    const getResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}`,
      {
        method: 'GET',
        headers
      }
    );
    const getData = (await getResponse.json()) as {
      pty: { cols: number; rows: number };
    };

    expect(getData.pty.cols).toBe(120);
    expect(getData.pty.rows).toBe(40);

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${createData.pty.id}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should send input via HTTP endpoint', async () => {
    // Create a PTY with explicit shell command and working directory
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/sh'], cwd: '/tmp' })
    });
    const createData = (await createResponse.json()) as {
      pty: { id: string };
    };

    // Send input via HTTP (fire-and-forget, just verify it doesn't error)
    const inputResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}/input`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: 'echo hello\n' })
      }
    );

    expect(inputResponse.status).toBe(200);
    const inputData = (await inputResponse.json()) as { success: boolean };
    expect(inputData.success).toBe(true);

    // Wait a bit for the command to execute
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${createData.pty.id}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should kill PTY session', async () => {
    // Create a PTY with explicit shell command and working directory
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/sh'], cwd: '/tmp' })
    });
    const createData = (await createResponse.json()) as {
      pty: { id: string; state: string };
    };

    console.log(
      '[Kill Test] Created PTY:',
      createData.pty.id,
      'state:',
      createData.pty.state
    );

    // Kill the PTY with SIGKILL for immediate termination
    const killResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}`,
      {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ signal: 'SIGKILL' })
      }
    );

    expect(killResponse.status).toBe(200);
    const killData = (await killResponse.json()) as {
      success: boolean;
      ptyId: string;
    };

    console.log('[Kill Test] Kill response:', killData);

    expect(killData.success).toBe(true);
    expect(killData.ptyId).toBe(createData.pty.id);

    // Wait for process to exit - poll with longer intervals
    let getData: { pty: { state: string; exitCode?: number } } | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const getResponse = await fetch(
        `${workerUrl}/api/pty/${createData.pty.id}`,
        {
          method: 'GET',
          headers
        }
      );

      getData = (await getResponse.json()) as {
        pty: { state: string; exitCode?: number };
      };
      console.log(
        `[Kill Test] Poll ${i + 1}: state=${getData.pty.state}, exitCode=${getData.pty.exitCode}`
      );
      if (getData.pty.state === 'exited') break;
    }

    // Verify PTY state is exited
    expect(getData?.pty.state).toBe('exited');
  }, 90000);

  test('should stream PTY output via SSE', async () => {
    // Create a PTY with explicit shell command and working directory
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: ['/bin/sh'], cwd: '/tmp' })
    });
    const createData = (await createResponse.json()) as {
      pty: { id: string };
    };

    // Open SSE stream
    const streamResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}/stream`,
      {
        method: 'GET',
        headers
      }
    );

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toBe(
      'text/event-stream'
    );

    // Send a command
    await fetch(`${workerUrl}/api/pty/${createData.pty.id}/input`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: 'echo "pty-test-output"\n' })
    });

    // Read some events from the stream
    const reader = streamResponse.body?.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];

    if (reader) {
      const timeout = Date.now() + 5000;

      while (Date.now() < timeout && events.length < 5) {
        const { value, done } = await reader.read();
        if (done) break;

        if (value) {
          const chunk = decoder.decode(value);
          events.push(chunk);

          // Stop if we see our test output
          if (chunk.includes('pty-test-output')) {
            break;
          }
        }
      }
      reader.cancel();
    }

    // Should have received some data
    expect(events.length).toBeGreaterThan(0);

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${createData.pty.id}`, {
      method: 'DELETE',
      headers
    });
  }, 90000);

  test('should attach PTY to existing session', async () => {
    // First create a session by running a command
    const sessionId = `pty-attach-test-${Date.now()}`;
    const sessionHeaders = {
      ...headers,
      'X-Session-Id': sessionId
    };

    // Run a command to initialize the session
    await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ command: 'cd /tmp && export MY_VAR=hello' })
    });

    // Attach PTY to session with explicit shell command
    const attachResponse = await fetch(
      `${workerUrl}/api/pty/attach/${sessionId}`,
      {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ cols: 80, rows: 24, command: ['/bin/sh'] })
      }
    );

    expect(attachResponse.status).toBe(200);
    const attachData = (await attachResponse.json()) as {
      success: boolean;
      pty: { id: string; sessionId: string };
    };

    expect(attachData.success).toBe(true);
    expect(attachData.pty.sessionId).toBe(sessionId);

    // Cleanup
    await fetch(`${workerUrl}/api/pty/${attachData.pty.id}`, {
      method: 'DELETE',
      headers: sessionHeaders
    });
  }, 90000);
});
