import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture every setAttribute call across all spans created during a test.
const attributeCalls: Array<[string, unknown]> = [];
let traced = false;

vi.mock('cloudflare:workers', () => ({
  tracing: {
    enterSpan: async (_name: string, callback: (span: unknown) => unknown) => {
      const span = {
        isTraced: traced,
        setAttribute: (key: string, value?: unknown) => {
          attributeCalls.push([key, value]);
        }
      };
      return callback(span);
    }
  }
}));

const { annotate, traced: tracedWrap } = await import('../../../../packages/sandbox/src/bridge/tracing');

type TestEnv = {
  Bindings: Record<string, unknown>;
  Variables: { containerUUID: string; span?: unknown };
};

function attr(key: string): unknown {
  return attributeCalls.find(([k]) => k === key)?.[1];
}

describe('bridge tracing helper', () => {
  beforeEach(() => {
    attributeCalls.length = 0;
    traced = true;
  });

  it('wraps a handler in a span seeded with common attributes', async () => {
    const app = new Hono<TestEnv>();
    app.use('/v1/sandbox/:id/thing', async (c, next) => {
      c.set('containerUUID', 'container-xyz');
      return next();
    });
    app.get(
      '/v1/sandbox/:id/thing',
      tracedWrap('thing', async (c) => c.json({ ok: true }))
    );

    const res = await app.request('/v1/sandbox/abc/thing');
    expect(res.status).toBe(200);

    expect(attr('bridge.operation')).toBe('thing');
    expect(attr('http.request.method')).toBe('GET');
    expect(attr('http.route')).toBe('/v1/sandbox/:id/thing');
    expect(attr('sandbox.id')).toBe('abc');
    expect(attr('sandbox.container_uuid')).toBe('container-xyz');
    expect(attr('http.response.status_code')).toBe(200);
  });

  it('exposes the active span to annotate()', async () => {
    const app = new Hono<TestEnv>();
    app.get(
      '/v1/sandbox/:id/thing',
      tracedWrap('thing', async (c) => {
        annotate(c, 'custom.key', 42);
        return c.json({ ok: true });
      })
    );

    await app.request('/v1/sandbox/abc/thing');
    expect(attr('custom.key')).toBe(42);
  });

  it('records the response status for error responses', async () => {
    const app = new Hono<TestEnv>();
    app.get(
      '/v1/sandbox/:id/thing',
      tracedWrap('thing', async (c) => c.json({ error: 'nope' }, 502))
    );

    const res = await app.request('/v1/sandbox/abc/thing');
    expect(res.status).toBe(502);
    expect(attr('http.response.status_code')).toBe(502);
  });

  it('annotate() is a no-op when no span is set', async () => {
    const app = new Hono<TestEnv>();
    app.get('/plain', async (c) => {
      // No traced() wrapper, so no span on the context.
      annotate(c, 'should.not.appear', 'x');
      return c.json({ ok: true });
    });

    const res = await app.request('/plain');
    expect(res.status).toBe(200);
    expect(attr('should.not.appear')).toBeUndefined();
  });
});
