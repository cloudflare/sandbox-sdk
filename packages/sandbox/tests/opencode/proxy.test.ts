// packages/sandbox/tests/opencode/proxy.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeProxy } from '../../src/opencode/proxy';
import type { Sandbox } from '../../src/sandbox';

interface MockSandbox {
  containerFetch: ReturnType<typeof vi.fn>;
}

function createMockSandbox(): MockSandbox {
  return {
    containerFetch: vi.fn().mockResolvedValue(new Response('proxied'))
  };
}

const env = {} as never;
const ctx = {} as ExecutionContext;

// ExportedHandler.fetch expects an incoming-request type; cast plain Requests.
function req(input: string, init?: RequestInit): Request<unknown, never> {
  return new Request(input, init) as unknown as Request<unknown, never>;
}

describe('createOpenCodeProxy', () => {
  it('is curried: resolve first, then wrap the handler', () => {
    const wrap = createOpenCodeProxy(
      () => createMockSandbox() as unknown as Sandbox
    );
    expect(typeof wrap).toBe('function');

    const handler = wrap({ fetch: vi.fn() });
    expect(typeof handler.fetch).toBe('function');
  });

  it('handles the web-UI route with a redirect (does not forward)', async () => {
    const sandbox = createMockSandbox();
    const userFetch = vi.fn();
    const handler = createOpenCodeProxy(() => sandbox as unknown as Sandbox)({
      fetch: userFetch
    });

    const response = await handler.fetch?.(
      req('http://example.com/', { headers: { accept: 'text/html' } }),
      env,
      ctx
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe(
      'http://example.com/?url=http%3A%2F%2Fexample.com'
    );
    expect(userFetch).not.toHaveBeenCalled();
  });

  it('forwards non-web-UI requests to the user handler', async () => {
    const sandbox = createMockSandbox();
    const userFetch = vi.fn().mockResolvedValue(new Response('user'));
    const handler = createOpenCodeProxy(() => sandbox as unknown as Sandbox)({
      fetch: userFetch
    });

    const request = req('http://example.com/api/test', { method: 'POST' });
    const response = await handler.fetch?.(request, env, ctx);

    expect(userFetch).toHaveBeenCalledOnce();
    expect(await response?.text()).toBe('user');
    expect(sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it('resolves the sandbox lazily, once per request', async () => {
    const resolve = vi.fn(() => createMockSandbox() as unknown as Sandbox);
    const handler = createOpenCodeProxy(resolve)({
      fetch: vi.fn().mockResolvedValue(new Response('user'))
    });

    expect(resolve).not.toHaveBeenCalled();

    await handler.fetch?.(req('http://example.com/api/a'), env, ctx);
    await handler.fetch?.(req('http://example.com/api/b'), env, ctx);

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('restricts the handled surface to a configured route prefix', async () => {
    const sandbox = createMockSandbox();
    const userFetch = vi.fn().mockResolvedValue(new Response('user'));
    const handler = createOpenCodeProxy(() => sandbox as unknown as Sandbox, {
      route: '/opencode'
    })({ fetch: userFetch });

    // HTML GET outside the route -> forwarded, not redirected.
    const outside = await handler.fetch?.(
      req('http://example.com/', { headers: { accept: 'text/html' } }),
      env,
      ctx
    );
    expect(userFetch).toHaveBeenCalledOnce();
    expect(await outside?.text()).toBe('user');

    // Request inside the route -> proxied to the container.
    await handler.fetch?.(req('http://example.com/opencode/app.js'), env, ctx);
    expect(sandbox.containerFetch).toHaveBeenCalled();
  });
});
