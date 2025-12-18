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

  test('should create a PTY session with default options', async () => {
    const response = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });

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
    };

    expect(data.success).toBe(true);
    expect(data.pty.id).toMatch(/^pty_/);
    expect(data.pty.cols).toBe(80);
    expect(data.pty.rows).toBe(24);
    expect(data.pty.command).toEqual(['bash']);
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
    // Create two PTYs
    const pty1Response = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cols: 80, rows: 24 })
    });
    const pty1 = (await pty1Response.json()) as { pty: { id: string } };

    const pty2Response = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cols: 100, rows: 30 })
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
    // Create a PTY
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cols: 100, rows: 50 })
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
    // Create a PTY
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cols: 80, rows: 24 })
    });
    const createData = (await createResponse.json()) as {
      pty: { id: string };
    };

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
    // Create a PTY
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
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
    // Create a PTY
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });
    const createData = (await createResponse.json()) as {
      pty: { id: string };
    };

    // Kill the PTY
    const killResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}`,
      {
        method: 'DELETE',
        headers
      }
    );

    expect(killResponse.status).toBe(200);
    const killData = (await killResponse.json()) as {
      success: boolean;
      ptyId: string;
    };

    expect(killData.success).toBe(true);
    expect(killData.ptyId).toBe(createData.pty.id);

    // Wait for process to exit
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify PTY state is exited
    const getResponse = await fetch(
      `${workerUrl}/api/pty/${createData.pty.id}`,
      {
        method: 'GET',
        headers
      }
    );

    const getData = (await getResponse.json()) as {
      pty: { state: string };
    };
    expect(getData.pty.state).toBe('exited');
  }, 90000);

  test('should stream PTY output via SSE', async () => {
    // Create a PTY
    const createResponse = await fetch(`${workerUrl}/api/pty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
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

    // Attach PTY to session
    const attachResponse = await fetch(
      `${workerUrl}/api/pty/attach/${sessionId}`,
      {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ cols: 80, rows: 24 })
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
