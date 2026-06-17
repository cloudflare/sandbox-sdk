import { describe, expect, it, vi } from 'vitest';
import { proxyTerminal } from '../src/pty';

describe('proxyTerminal', () => {
  it('routes terminal websocket upgrades to the terminal endpoint', async () => {
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

    await proxyTerminal(stub, 'terminal-123', request, {
      cols: 120,
      rows: 40,
      shell: '/bin/bash'
    });

    expect(stub.fetch).toHaveBeenCalledOnce();
    expect(proxiedRequest).toBeDefined();
    const url = new URL(proxiedRequest?.url ?? 'http://missing');
    expect(url.pathname).toBe('/ws/terminal');
    expect(url.searchParams.get('terminalId')).toBe('terminal-123');
    expect(url.searchParams.get('cols')).toBe('120');
    expect(url.searchParams.get('rows')).toBe('40');
    expect(url.searchParams.get('shell')).toBe('/bin/bash');
  });
});
