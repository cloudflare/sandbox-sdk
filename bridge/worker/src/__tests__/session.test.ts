import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, createMockSession, parseSSE, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

describe('POST /v1/sandbox/:id/session — create session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a session with provided ID', async () => {
    mockSandbox.createSession.mockResolvedValue({ id: 'my-sess' });

    const res = await app.request(
      sandboxUrl('test', 'session'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'my-sess' })
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('my-sess');
    expect(mockSandbox.createSession).toHaveBeenCalledWith({ id: 'my-sess' });
  });

  it('returns 502 when createSession throws', async () => {
    mockSandbox.createSession.mockRejectedValue(new Error('container down'));

    const res = await app.request(
      sandboxUrl('test', 'session'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      },
      env
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('session_error');
    expect(body.error).toContain('container down');
  });
});

describe('DELETE /v1/sandbox/:id/session/:sid — delete session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a session and returns result', async () => {
    const deleteResult = { success: true, sessionId: 'sess-1', timestamp: '2025-01-01T00:00:00Z' };
    mockSandbox.deleteSession.mockResolvedValue(deleteResult);

    const res = await app.request(
      `http://localhost/v1/sandbox/test/session/sess-1`,
      {
        method: 'DELETE'
      },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(deleteResult);
    expect(mockSandbox.deleteSession).toHaveBeenCalledWith('sess-1');
  });

  it('returns 502 when deleteSession throws', async () => {
    mockSandbox.deleteSession.mockRejectedValue(new Error('not found'));

    const res = await app.request(
      `http://localhost/v1/sandbox/test/session/bad-id`,
      {
        method: 'DELETE'
      },
      env
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('session_error');
    expect(body.error).toContain('not found');
  });
});

describe('Session-Id header on exec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses getSession when Session-Id header is present', async () => {
    const session = createMockSession('my-session');
    session.exec.mockImplementation(async (_cmd: string, opts?: Record<string, unknown>) => {
      const onComplete = opts?.onComplete as (r: { exitCode: number }) => void;
      if (onComplete) onComplete({ exitCode: 0 });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockSandbox.getSession.mockResolvedValue(session);

    const res = await app.request(
      sandboxUrl('test', 'exec'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Session-Id': 'my-session'
        },
        body: JSON.stringify({ argv: ['echo', 'hi'] })
      },
      env
    );

    expect(res.status).toBe(200);
    expect(mockSandbox.getSession).toHaveBeenCalledWith('my-session');
    expect(session.exec).toHaveBeenCalled();
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('uses sandbox directly when no Session-Id header', async () => {
    mockSandbox.exec.mockImplementation(async (_cmd: string, opts?: Record<string, unknown>) => {
      const onComplete = opts?.onComplete as (r: { exitCode: number }) => void;
      if (onComplete) onComplete({ exitCode: 0 });
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const res = await app.request(
      sandboxUrl('test', 'exec'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ argv: ['echo', 'hi'] })
      },
      env
    );

    expect(res.status).toBe(200);
    expect(mockSandbox.getSession).not.toHaveBeenCalled();
    expect(mockSandbox.exec).toHaveBeenCalled();
  });
});

describe('Session-Id header on file operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes file read to the specified session', async () => {
    const session = createMockSession('file-sess');
    mockSandbox.getSession.mockResolvedValue(session);

    await app.request(
      `http://localhost/v1/sandbox/test/file/workspace/test.txt`,
      { method: 'GET', headers: { 'Session-Id': 'file-sess' } },
      env
    );

    expect(mockSandbox.getSession).toHaveBeenCalledWith('file-sess');
    expect(session.readFileStream).toHaveBeenCalledWith('/workspace/test.txt');
  });

  it('scopes file write to the specified session', async () => {
    const session = createMockSession('file-sess');
    mockSandbox.getSession.mockResolvedValue(session);

    await app.request(
      `http://localhost/v1/sandbox/test/file/workspace/test.txt`,
      { method: 'PUT', headers: { 'Session-Id': 'file-sess' }, body: 'hello' },
      env
    );

    expect(mockSandbox.getSession).toHaveBeenCalledWith('file-sess');
    expect(session.writeFile).toHaveBeenCalled();
  });
});

describe('PTY session precedence', () => {
  const MOCK_TERMINAL_RESPONSE = new Response(null, { status: 200 });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.terminal.mockImplementation(async () => MOCK_TERMINAL_RESPONSE);
  });

  it('header takes priority over query param', async () => {
    const headerSession = createMockSession('from-header');
    headerSession.terminal.mockResolvedValue(MOCK_TERMINAL_RESPONSE);
    mockSandbox.getSession.mockResolvedValue(headerSession);

    const res = await app.request(
      sandboxUrl('test', 'pty', 'session=from-query'),
      {
        method: 'GET',
        headers: { Upgrade: 'websocket', 'Session-Id': 'from-header' }
      },
      env
    );

    expect(res.status).toBe(200);
    expect(mockSandbox.getSession).toHaveBeenCalledWith('from-header');
  });

  it('uses query param when no header is present', async () => {
    const querySession = createMockSession('from-query');
    querySession.terminal.mockResolvedValue(MOCK_TERMINAL_RESPONSE);
    mockSandbox.getSession.mockResolvedValue(querySession);

    const res = await app.request(
      sandboxUrl('test', 'pty', 'session=from-query'),
      {
        method: 'GET',
        headers: { Upgrade: 'websocket' }
      },
      env
    );

    expect(res.status).toBe(200);
    expect(mockSandbox.getSession).toHaveBeenCalledWith('from-query');
  });
});

describe('Session ID validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['../etc/passwd', 'path traversal'],
    ['bad/session', 'slashes'],
    ['session id', 'spaces']
  ])('rejects %s (%s)', async (sessionId) => {
    const res = await app.request(
      sandboxUrl('test', 'exec'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Session-Id': sessionId },
        body: JSON.stringify({ argv: ['echo', 'hi'] })
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_request');
  });
});
