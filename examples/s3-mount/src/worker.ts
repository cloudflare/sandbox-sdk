import { getSandbox } from '@cloudflare/sandbox';
import { Hono } from 'hono';
import { mountBucket, unmountBucket } from './sandbox';

// ---------------------------------------------------------------------------
// Browser session flow: create a fresh sandbox per click, mount the bucket,
// proxy a PTY over WebSocket, unmount on cleanup.
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

/** POST /api/session — create a new sandbox, mount the bucket, return its id. */
app.post('/api/session', async (c) => {
  // Random sandbox id so each click gets a fresh container.
  const sandboxId = `s3-${crypto.randomUUID().slice(0, 12)}`;

  try {
    const sandbox = getSandbox(c.env.Sandbox, sandboxId);
    const result = await mountBucket(sandbox, c.env);
    if (!result.ok) {
      return c.json({ ...result, sandboxId }, 500);
    }
    return c.json({ sandboxId, mount: result.status });
  } catch (err) {
    // Surface the real error to the client so we don't get a generic 1101
    // "Worker threw exception" HTML page. Still logged for `wrangler tail`.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('POST /api/session failed', { sandboxId, message, stack });
    return c.json({ ok: false, sandboxId, error: message, stack }, 500);
  }
});

/** POST /api/session/:sandboxId/cleanup — best-effort unmount. */
app.post('/api/session/:sandboxId/cleanup', async (c) => {
  const sandbox = getSandbox(c.env.Sandbox, c.req.param('sandboxId'));
  await unmountBucket(sandbox);
  return c.json({ status: 'cleaned-up' });
});

/** POST /api/session/:sandboxId/exec — debug: run a shell command in the sandbox. */
app.post('/api/session/:sandboxId/exec', async (c) => {
  const sandbox = getSandbox(c.env.Sandbox, c.req.param('sandboxId'));
  const { cmd } = await c.req.json<{ cmd: string }>();
  // Subshell so a failing command doesn't poison the default session.
  const result = await sandbox.exec(`(${cmd})`);
  return c.json({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  });
});

/** WS /ws/terminal/:sandboxId — xterm WebSocket proxy onto the default session. */
app.get('/ws/terminal/:sandboxId', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }
  const sandbox = getSandbox(c.env.Sandbox, c.req.param('sandboxId'));
  const session = await sandbox.createSession({ cwd: '/mnt/s3' });
  return session.terminal(c.req.raw);
});

// Catch-all: anything we don't handle falls through to the static-asset
// binding (index.html etc.).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
