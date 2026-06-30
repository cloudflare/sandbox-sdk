import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeHandle } from '../../src/opencode/lifecycle';
import { createOpenCodeProxy } from '../../src/opencode/proxy';

interface MockHandle {
  fetch: ReturnType<typeof vi.fn>;
}

function createMockHandle(): MockHandle {
  return {
    fetch: vi.fn().mockResolvedValue(new Response('proxied'))
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
      () => createMockHandle() as unknown as OpenCodeHandle
    );
    expect(typeof wrap).toBe('function');

    const handler = wrap({ fetch: vi.fn() });
    expect(typeof handler.fetch).toBe('function');
  });

  it('returns the user handler response for its own routes', async () => {
    const handle = createMockHandle();
    const userFetch = vi
      .fn()
      .mockResolvedValue(new Response('user', { status: 200 }));
    const handler = createOpenCodeProxy(
      () => handle as unknown as OpenCodeHandle
    )({ fetch: userFetch });

    const response = await handler.fetch?.(
      req('http://example.com/api/test', { method: 'POST' }),
      env,
      ctx
    );

    expect(userFetch).toHaveBeenCalledOnce();
    expect(await response?.text()).toBe('user');
    expect(handle.fetch).not.toHaveBeenCalled();
  });

  it('redirects the web-UI handshake when the handler 404s', async () => {
    const handle = createMockHandle();
    const handler = createOpenCodeProxy(
      () => handle as unknown as OpenCodeHandle
    )({
      fetch: vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
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
    // A redirect needs no server, so the handle is not touched.
    expect(handle.fetch).not.toHaveBeenCalled();
  });

  it('ensures + proxies post-handshake web-UI requests via the handle', async () => {
    const handle = createMockHandle();
    const handler = createOpenCodeProxy(
      () => handle as unknown as OpenCodeHandle
    )({
      fetch: vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
    });

    // GET /?url=... (post-redirect) must reach the container via the handle,
    // which ensures the server is running first.
    await handler.fetch?.(
      req('http://example.com/?url=http://example.com', {
        headers: { accept: 'text/html' }
      }),
      env,
      ctx
    );

    expect(handle.fetch).toHaveBeenCalledOnce();
  });

  it('ensures + proxies web-UI asset requests when the handler 404s', async () => {
    const handle = createMockHandle();
    const handler = createOpenCodeProxy(
      () => handle as unknown as OpenCodeHandle
    )({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    });

    await handler.fetch?.(req('http://example.com/app.js'), env, ctx);

    expect(handle.fetch).toHaveBeenCalledOnce();
  });

  it('falls through to the proxy when there is no handler fetch', async () => {
    const handle = createMockHandle();
    const handler = createOpenCodeProxy(
      () => handle as unknown as OpenCodeHandle
    )({});

    await handler.fetch?.(req('http://example.com/app.js'), env, ctx);

    expect(handle.fetch).toHaveBeenCalledOnce();
  });

  it('preserves non-fetch handlers like scheduled and queue', async () => {
    const scheduled = vi.fn();
    const queue = vi.fn();
    const handler = createOpenCodeProxy(
      () => createMockHandle() as unknown as OpenCodeHandle
    )({ fetch: vi.fn(), scheduled, queue });

    expect(handler.scheduled).toBe(scheduled);
    expect(handler.queue).toBe(queue);
  });

  it('resolves the handle lazily, only when proxying', async () => {
    const resolve = vi.fn(
      () => createMockHandle() as unknown as OpenCodeHandle
    );
    const handler = createOpenCodeProxy(resolve)({
      fetch: vi
        .fn()
        .mockResolvedValueOnce(new Response('user', { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
    });

    expect(resolve).not.toHaveBeenCalled();

    // Handler owns this one -> no resolve.
    await handler.fetch?.(req('http://example.com/api/a'), env, ctx);
    expect(resolve).not.toHaveBeenCalled();

    // Handler 404s -> proxy resolves the handle.
    await handler.fetch?.(req('http://example.com/app.js'), env, ctx);
    expect(resolve).toHaveBeenCalledOnce();
  });
});
