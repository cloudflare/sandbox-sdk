import { describe, expect, it, vi } from 'vitest';
import { proxyTerminal } from '../src/pty';

describe('proxyTerminal', () => {
  it('routes terminal websocket upgrades with explicit terminal IDs', async () => {
    let proxiedRequest: Request | undefined;
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        proxiedRequest = request;
        return new Response(null, { status: 200 });
      })
    };
    const request = new Request('https://example.com/terminal', {
      headers: { Upgrade: 'websocket' }
    });

    await proxyTerminal(stub, request, {
      id: 'terminal-123',
      cols: 120,
      rows: 40,
      shell: '/bin/bash',
      cwd: '/mnt/s3'
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

  it('generates a terminal ID when none is provided', async () => {
    let proxiedRequest: Request | undefined;
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        proxiedRequest = request;
        return new Response(null, { status: 200 });
      })
    };
    const request = new Request('https://example.com/terminal', {
      headers: { Upgrade: 'websocket' }
    });

    await proxyTerminal(stub, request);

    expect(proxiedRequest).toBeDefined();
    const url = new URL(proxiedRequest?.url ?? 'http://missing');
    expect(url.searchParams.get('terminalId')).toMatch(
      /^terminal-[0-9a-f-]{36}$/
    );
    expect(url.searchParams.get('ephemeral')).toBe('1');
  });
});
