import { getSandbox } from '@cloudflare/sandbox';
import { Hono } from 'hono';
import { mountBucket, unmountBucket } from './sandbox';

const app = new Hono<{ Bindings: Env }>();

/** POST /api/session — create a new sandbox, mount the bucket, return its id and terminalId. */
app.post('/api/session', async (c) => {
  const sandboxId = `s3-${crypto.randomUUID().slice(0, 12)}`;

  try {
    const sandbox = getSandbox(c.env.Sandbox, sandboxId);
    const result = await mountBucket(sandbox, c.env);
    if (!result.ok) {
      return c.json({ ...result, sandboxId }, 500);
    }

    try {
      const terminal = await sandbox.createTerminal({
        command: ['bash'],
        cwd: '/mnt/s3'
      });
      return c.json({
        sandboxId,
        terminalId: terminal.id,
        mount: result.status
      });
    } catch (err) {
      // Best-effort unmount if terminal creation fails
      try {
        await unmountBucket(sandbox);
      } catch (unmountErr) {
        console.error(
          'Best-effort unmount failed after terminal creation failed',
          unmountErr
        );
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('POST /api/session failed', { sandboxId, message, stack });
    return c.json({ ok: false, sandboxId, error: message, stack }, 500);
  }
});

/** POST /api/session/:sandboxId/cleanup — best-effort unmount and terminal terminate. */
app.post('/api/session/:sandboxId/cleanup', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  let terminalId: string | undefined;
  try {
    const body = await c.req.json<{ terminalId?: string }>();
    terminalId = body?.terminalId;
  } catch {
    // Ignore invalid or empty JSON body
  }
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);

  if (terminalId) {
    try {
      const terminal = await sandbox.getTerminal(terminalId);
      if (terminal) {
        await terminal.terminate();
      }
    } catch (err) {
      console.error(
        'Best-effort terminal terminate failed during cleanup',
        err
      );
    }
  }

  try {
    await unmountBucket(sandbox);
  } catch (err) {
    console.error('Best-effort unmount failed during cleanup', err);
  }

  return c.json({ status: 'cleaned-up' });
});

/** POST /api/session/:sandboxId/exec — debug: run a shell command in the sandbox. */
app.post('/api/session/:sandboxId/exec', async (c) => {
  const sandbox = getSandbox(c.env.Sandbox, c.req.param('sandboxId'));
  const { cmd } = await c.req.json<{ cmd: string }>();
  const resultProc = await sandbox.exec(['/bin/bash', '-lc', `(${cmd})`]);
  const result = await resultProc.output({ encoding: 'utf8' });
  return c.json({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  });
});

/** WS /ws/terminal/:sandboxId — xterm WebSocket proxy onto the mounted bucket. */
app.get('/ws/terminal/:sandboxId', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }
  const sandboxId = c.req.param('sandboxId');
  const terminalId = c.req.query('terminalId');
  if (!terminalId) {
    return c.text('Missing terminalId query parameter', 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const terminal = await sandbox.getTerminal(terminalId);
  if (!terminal) {
    return c.text(`Terminal not found: ${terminalId}`, 404);
  }

  return terminal.connect(c.req.raw);
});

// Catch-all: anything we don't handle falls through to the static-asset
// binding (index.html etc.).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
