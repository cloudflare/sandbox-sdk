import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

// In Node/Vitest we can't construct a Response with status 101 (WebSocket
// upgrade), so we use 200 as a stand-in.  The tests verify routing, parameter
// parsing, and auth — actual WebSocket framing requires integration tests.
const MOCK_TERMINAL_RESPONSE = new Response(null, { status: 200 });

/** Send a GET request with WebSocket upgrade headers. */
function wsUpgradeRequest(url: string, headers?: Record<string, string>, envOverride?: Record<string, unknown>) {
  return app.request(
    url,
    {
      method: 'GET',
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', ...headers }
    },
    envOverride ?? env
  );
}

describe('GET /v1/sandbox/:id/pty — WebSocket PTY proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.terminal.mockImplementation(async () => MOCK_TERMINAL_RESPONSE);
    mockSandbox.getSession.mockImplementation(async () => ({
      id: 'mock-session',
      terminal: vi.fn(async () => MOCK_TERMINAL_RESPONSE)
    }));
  });

  it('rejects request without Upgrade header with 400', async () => {
    const res = await app.request(sandboxUrl('test', 'pty'), { method: 'GET' }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('WebSocket upgrade required');
    expect(body.code).toBe('invalid_request');
  });

  it('calls sandbox.terminal() with parsed PtyOptions', async () => {
    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty', 'cols=120&rows=30&shell=/bin/zsh'));
    expect(res.status).toBe(200);
    expect(mockSandbox.terminal).toHaveBeenCalledTimes(1);

    const [, opts] = mockSandbox.terminal.mock.calls[0] as [Request, Record<string, unknown>];
    expect(opts).toEqual({ cols: 120, rows: 30, shell: '/bin/zsh' });
  });

  it('uses default cols=80 rows=24 when no query params', async () => {
    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty'));
    expect(res.status).toBe(200);
    expect(mockSandbox.terminal).toHaveBeenCalledTimes(1);

    const [, opts] = mockSandbox.terminal.mock.calls[0] as [Request, Record<string, unknown>];
    expect(opts).toEqual({ cols: 80, rows: 24 });
  });

  it('passes through the terminal() Response as-is', async () => {
    const customResponse = new Response('custom-body', {
      status: 200,
      headers: { 'X-Test': 'yes' }
    });
    mockSandbox.terminal.mockResolvedValue(customResponse);

    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty'));
    expect(res).toBe(customResponse);
  });

  it('returns 400 for non-numeric cols', async () => {
    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty', 'cols=abc'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('cols and rows must be valid numbers');
  });

  it('returns 400 for non-numeric rows', async () => {
    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty', 'rows=xyz'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('cols and rows must be valid numbers');
  });

  it('returns 502 when terminal() throws', async () => {
    mockSandbox.terminal.mockRejectedValue(new Error('container unreachable'));

    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty'));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('container unreachable');
    expect(body.code).toBe('exec_transport_error');
  });

  it('uses session.terminal() when session query param is provided', async () => {
    const sessionTerminal = vi.fn(async () => MOCK_TERMINAL_RESPONSE);
    mockSandbox.getSession.mockResolvedValue({ id: 'my-session', terminal: sessionTerminal });

    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty', 'session=my-session&cols=100&rows=50'));
    expect(res.status).toBe(200);

    expect(mockSandbox.getSession).toHaveBeenCalledWith('my-session');
    expect(sessionTerminal).toHaveBeenCalledTimes(1);
    const [, opts] = sessionTerminal.mock.calls[0] as [Request, Record<string, unknown>];
    expect(opts).toEqual({ cols: 100, rows: 50 });

    // sandbox.terminal() should NOT have been called
    expect(mockSandbox.terminal).not.toHaveBeenCalled();
  });

  it('returns 502 when getSession() throws', async () => {
    mockSandbox.getSession.mockRejectedValue(new Error('Session not found'));

    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty', 'session=bad-id'));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('Session not found');
    expect(body.code).toBe('exec_transport_error');
  });
});

describe('GET /v1/sandbox/:id/pty — auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.terminal.mockImplementation(async () => MOCK_TERMINAL_RESPONSE);
  });

  it('requires auth when SANDBOX_API_KEY is set', async () => {
    const res = await wsUpgradeRequest(sandboxUrl('test', 'pty'), {}, createMockEnv({ SANDBOX_API_KEY: 'secret' }));
    expect(res.status).toBe(401);
  });

  it('accepts valid auth token', async () => {
    const res = await wsUpgradeRequest(
      sandboxUrl('test', 'pty'),
      { Authorization: 'Bearer secret' },
      createMockEnv({ SANDBOX_API_KEY: 'secret' })
    );
    expect(res.status).toBe(200);
    expect(mockSandbox.terminal).toHaveBeenCalled();
  });
});
