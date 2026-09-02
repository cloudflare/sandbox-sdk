import { describe, expect, it, vi } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import type { Container } from '@sandbox-container/core/container';
import { Router } from '@sandbox-container/core/router';
import { setupRoutes } from '@sandbox-container/routes/setup';

function createContainer(watchHandle: ReturnType<typeof vi.fn>): Container {
  const loggingMiddleware = {
    handle: vi.fn(
      async (
        _request: Request,
        _context: unknown,
        next: () => Promise<Response>
      ) => next()
    )
  };
  const watchHandler = { handle: watchHandle };
  return {
    get: vi.fn((name: string) =>
      name === 'loggingMiddleware' ? loggingMiddleware : watchHandler
    )
  } as unknown as Container;
}

describe('setupRoutes watch mount route', () => {
  it('registers POST /api/watch/mount', async () => {
    const watchHandle = vi.fn(async () => new Response('watching'));
    const router = new Router(createNoOpLogger());
    setupRoutes(router, createContainer(watchHandle));
    const response = await router.route(
      new Request('http://localhost:3000/api/watch/mount', { method: 'POST' })
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('watching');
    expect(watchHandle).toHaveBeenCalledTimes(1);
  });

  it('does not register GET /api/watch/mount', async () => {
    const watchHandle = vi.fn(async () => new Response('watching'));
    const router = new Router(createNoOpLogger());
    setupRoutes(router, createContainer(watchHandle));
    const response = await router.route(
      new Request('http://localhost:3000/api/watch/mount')
    );
    expect(response.status).toBe(404);
    expect(watchHandle).not.toHaveBeenCalled();
  });
});
