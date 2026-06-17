import { describe, expect, it, vi } from 'vitest';
import { createSandboxTerminal } from '../src/pty';

describe('createSandboxTerminal', () => {
  it('routes terminal handle connections with explicit terminal IDs', async () => {
    let proxiedRequest: Request | undefined;
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        proxiedRequest = request;
        return new Response(null, { status: 200 });
      }),
      destroyTerminal: vi.fn(async (_id: string) => {})
    };
    const request = new Request('https://example.com/terminal', {
      headers: { Upgrade: 'websocket' }
    });

    const terminal = createSandboxTerminal(stub, {
      id: 'terminal-123',
      shell: '/bin/bash',
      cwd: '/mnt/s3'
    });

    expect(terminal.id).toBe('terminal-123');

    await terminal.connect(request, {
      cols: 120,
      rows: 40
    });

    expect(stub.fetch).toHaveBeenCalledOnce();
    expect(proxiedRequest).toBeDefined();
    const url = new URL(proxiedRequest?.url ?? 'http://missing');
    expect(url.pathname).toBe('/ws/terminal');
    expect(url.searchParams.get('terminalId')).toBe('terminal-123');
    expect(url.searchParams.get('id')).toBeNull();
    expect(url.searchParams.get('ephemeral')).toBeNull();
    expect(url.searchParams.get('cols')).toBe('120');
    expect(url.searchParams.get('rows')).toBe('40');
    expect(url.searchParams.get('shell')).toBe('/bin/bash');
    expect(url.searchParams.get('cwd')).toBe('/mnt/s3');
  });

  it('generates visible terminal IDs when none is provided', async () => {
    let proxiedRequest: Request | undefined;
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        proxiedRequest = request;
        return new Response(null, { status: 200 });
      }),
      destroyTerminal: vi.fn(async (_id: string) => {})
    };
    const request = new Request('https://example.com/terminal', {
      headers: { Upgrade: 'websocket' }
    });

    const terminal = createSandboxTerminal(stub);

    expect(terminal.id).toMatch(/^terminal-[0-9a-f-]{36}$/);

    await terminal.connect(request);

    expect(proxiedRequest).toBeDefined();
    const url = new URL(proxiedRequest?.url ?? 'http://missing');
    expect(url.searchParams.get('terminalId')).toBe(terminal.id);
    expect(url.searchParams.get('ephemeral')).toBeNull();
  });

  it('destroys terminal resources through the lifecycle API', async () => {
    const stub = {
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
      destroyTerminal: vi.fn(async (_id: string) => {})
    };

    const terminal = createSandboxTerminal(stub, { id: 'terminal-123' });

    await terminal.destroy();

    expect(stub.destroyTerminal).toHaveBeenCalledWith('terminal-123');
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});
