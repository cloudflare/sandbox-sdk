import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, createMockTerminal, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();
const MOCK_TERMINAL_RESPONSE = new Response(null, { status: 200 });

function mockTerminalResponse(response = MOCK_TERMINAL_RESPONSE) {
  const handle = createMockTerminal({ id: 'mock-terminal' });
  handle.connect.mockResolvedValue(response);
  mockSandbox.createTerminal.mockResolvedValue(handle);
  mockSandbox.getTerminal.mockResolvedValue(handle);
  mockSandbox.listTerminals.mockResolvedValue([handle]);
  return handle;
}

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

describe('terminal bridge routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminalResponse();
  });

  it('creates terminals with argv and returns a snapshot', async () => {
    const terminal = mockTerminalResponse();
    const res = await app.request(
      sandboxUrl('test', 'terminals'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ argv: ['bash'], cwd: '/workspace', env: { A: 'B' }, cols: 120, rows: 30 })
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: terminal.id, command: ['bash'], status: 'running' });
    expect(mockSandbox.createTerminal).toHaveBeenCalledWith({
      command: ['bash'],
      cwd: '/workspace',
      env: { A: 'B' },
      cols: 120,
      rows: 30
    });
  });

  it('lists and gets terminal snapshots', async () => {
    const list = await app.request(sandboxUrl('test', 'terminals'), { method: 'GET' }, env);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject([{ id: 'mock-terminal' }]);

    const get = await app.request(sandboxUrl('test', 'terminals/mock-terminal'), { method: 'GET' }, env);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ id: 'mock-terminal' });
  });

  it('returns 404 for missing terminals', async () => {
    mockSandbox.getTerminal.mockResolvedValue(null);
    const res = await app.request(sandboxUrl('test', 'terminals/missing'), { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });

  it('rejects connect without Upgrade header with 400', async () => {
    const res = await app.request(sandboxUrl('test', 'terminals/mock-terminal/connect'), { method: 'GET' }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('WebSocket upgrade required');
    expect(body.code).toBe('invalid_request');
  });

  it('connects with cursor and dimensions', async () => {
    const terminal = mockTerminalResponse();
    const res = await wsUpgradeRequest(
      sandboxUrl('test', 'terminals/mock-terminal/connect', 'cursor=abc&cols=120&rows=30')
    );

    expect(res.status).toBe(200);
    expect(mockSandbox.getTerminal).toHaveBeenCalledWith('mock-terminal');
    const [, connectOptions] = terminal.connect.mock.calls[0] as [Request, Record<string, unknown>];
    expect(connectOptions).toEqual({ cursor: 'abc', cols: 120, rows: 30 });
  });

  it('passes through the terminal connect Response', async () => {
    const customResponse = new Response('custom-body', {
      status: 200,
      headers: { 'X-Test': 'yes' }
    });
    mockTerminalResponse(customResponse);

    const res = await wsUpgradeRequest(sandboxUrl('test', 'terminals/mock-terminal/connect'));
    expect(await res.text()).toBe('custom-body');
    expect(res.headers.get('X-Test')).toBe('yes');
  });

  it('returns 400 for invalid connect dimensions', async () => {
    const cols = await wsUpgradeRequest(sandboxUrl('test', 'terminals/mock-terminal/connect', 'cols=abc'));
    expect(cols.status).toBe(400);
    const rows = await wsUpgradeRequest(sandboxUrl('test', 'terminals/mock-terminal/connect', 'rows=xyz'));
    expect(rows.status).toBe(400);
  });

  it('returns 502 when terminal connect throws', async () => {
    const terminal = mockTerminalResponse();
    terminal.connect.mockRejectedValue(new Error('container unreachable'));

    const res = await wsUpgradeRequest(sandboxUrl('test', 'terminals/mock-terminal/connect'));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('container unreachable');
    expect(body.code).toBe('exec_transport_error');
  });

  it('interrupts and terminates terminal handles', async () => {
    const terminal = mockTerminalResponse();

    const interrupt = await app.request(
      sandboxUrl('test', 'terminals/mock-terminal/interrupt'),
      { method: 'POST' },
      env
    );
    const terminate = await app.request(
      sandboxUrl('test', 'terminals/mock-terminal/terminate'),
      { method: 'POST' },
      env
    );

    expect(interrupt.status).toBe(204);
    expect(terminate.status).toBe(204);
    expect(terminal.interrupt).toHaveBeenCalledOnce();
    expect(terminal.terminate).toHaveBeenCalledOnce();
  });
});

describe('terminal bridge auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminalResponse();
  });

  it('requires auth when SANDBOX_API_KEY is set', async () => {
    const res = await wsUpgradeRequest(
      sandboxUrl('test', 'terminals/mock-terminal/connect'),
      {},
      createMockEnv({ SANDBOX_API_KEY: 'secret' })
    );
    expect(res.status).toBe(401);
  });

  it('accepts valid auth token', async () => {
    const res = await wsUpgradeRequest(
      sandboxUrl('test', 'terminals/mock-terminal/connect'),
      { Authorization: 'Bearer secret' },
      createMockEnv({ SANDBOX_API_KEY: 'secret' })
    );
    expect(res.status).toBe(200);
    expect(mockSandbox.getTerminal).toHaveBeenCalled();
  });
});
