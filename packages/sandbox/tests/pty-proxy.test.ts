import { describe, expect, it, vi } from 'vitest';
import { createSandboxTerminal } from '../src/pty';

function createStub(onFetch?: (request: Request) => void | Promise<void>) {
  return {
    fetch: vi.fn(async (request: Request) => {
      await onFetch?.(request);
      return new Response(null, { status: 200 });
    }),
    createTerminal: vi.fn(
      async (options: { id: string; cwd?: string; shell?: string }) => ({
        success: true as const,
        id: options.id
      })
    ),
    destroyTerminal: vi.fn(async (_id: string) => {})
  };
}

describe('createSandboxTerminal', () => {
  it('creates terminal resources before connecting by explicit terminal ID', async () => {
    let proxiedRequest: Request | undefined;
    const stub = createStub((request) => {
      proxiedRequest = request;
    });
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

    expect(stub.createTerminal).toHaveBeenCalledBefore(stub.fetch);
    expect(stub.createTerminal).toHaveBeenCalledWith({
      id: 'terminal-123',
      cwd: '/mnt/s3',
      shell: '/bin/bash',
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
    expect(url.searchParams.get('shell')).toBeNull();
    expect(url.searchParams.get('cwd')).toBeNull();
  });

  it('generates visible terminal IDs when none is provided', async () => {
    let proxiedRequest: Request | undefined;
    const stub = createStub((request) => {
      proxiedRequest = request;
    });
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
    expect(stub.createTerminal).toHaveBeenCalledWith({ id: terminal.id });
  });

  it('destroys terminal resources through the lifecycle API', async () => {
    const stub = createStub();

    const terminal = createSandboxTerminal(stub, { id: 'terminal-123' });

    await terminal.destroy();

    expect(stub.destroyTerminal).toHaveBeenCalledWith('terminal-123');
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});
