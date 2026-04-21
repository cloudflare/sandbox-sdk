/**
 * Hono application containing all bridge API routes.
 *
 * This module creates the Hono app parameterised by the bridge configuration
 * (binding names, route prefixes). The app is created once by the bridge()
 * factory and reused for all requests.
 */

import type { ExecutionSession, ISandbox, PtyOptions } from '@repo/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Sandbox } from '../sandbox';
import { getSandbox as _getSandbox } from '../sandbox';
import {
  base32Encode,
  errorJson,
  resolveWorkspacePath,
  shellQuote,
  sseToByteStream,
  toBase64,
  validateSessionId
} from './helpers';
import { OPENAPI_SCHEMA } from './openapi';
import { renderOpenApiHtml } from './openapi-html';
import { primePool } from './pool';
import type {
  BridgeEnv,
  ExecRequest,
  MountBucketRequest,
  RunningResponse,
  UnmountBucketRequest,
  WriteResponse
} from './types';

// ---------------------------------------------------------------------------
// BridgeSandbox type
// ---------------------------------------------------------------------------

/**
 * The SDK's getSandbox() proxy exposes methods not declared on ISandbox
 * (terminal, destroy) or declared with a narrower return type (getSession
 * without terminal). This type extends ISandbox with those extra methods
 * so call sites get type safety without per-call casts.
 */
type BridgeSandbox = ISandbox & {
  terminal(request: Request, options?: PtyOptions): Promise<Response>;
  getSession(sessionId: string): Promise<
    ExecutionSession & {
      terminal(request: Request, options?: PtyOptions): Promise<Response>;
    }
  >;
  destroy(): Promise<void>;
};

/** Typed wrapper around the SDK's getSandbox() that returns a BridgeSandbox. */
function getSandbox<T extends Sandbox<any>>(
  ns: DurableObjectNamespace<T>,
  containerUUID: string
): BridgeSandbox {
  return _getSandbox(ns, containerUUID) as unknown as BridgeSandbox;
}

// ---------------------------------------------------------------------------
// Route configuration
// ---------------------------------------------------------------------------

export interface RouteConfig {
  sandboxBinding: string;
  warmPoolBinding: string;
  apiPrefix: string;
  healthPath: string;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createBridgeApp(
  config: RouteConfig
): Hono<{ Bindings: BridgeEnv; Variables: { containerUUID: string } }> {
  const app = new Hono<{
    Bindings: BridgeEnv;
    Variables: { containerUUID: string };
  }>();

  const { sandboxBinding, warmPoolBinding, apiPrefix } = config;

  // Helper to get the Sandbox DO namespace from env
  function getSandboxNs(env: BridgeEnv): DurableObjectNamespace<any> {
    return env[sandboxBinding] as DurableObjectNamespace<any>;
  }

  function getWarmPoolNs(env: BridgeEnv): DurableObjectNamespace {
    return env[warmPoolBinding] as DurableObjectNamespace;
  }

  // ------------------------------------------------------------------
  // Auth middleware — applies to all /sandbox/* routes
  // ------------------------------------------------------------------

  app.use(`${apiPrefix}/sandbox/*`, async (c, next) => {
    // Validate sandbox ID format
    const url = new URL(c.req.url);
    const pathParts = url.pathname.split('/');
    // Path is {prefix}/sandbox/:id/... — find the ID
    const prefixParts = apiPrefix.split('/').filter(Boolean);
    const sandboxId = pathParts[prefixParts.length + 2]; // +1 for leading empty, +1 for "sandbox"
    if (sandboxId && !/^[a-z2-7]{1,128}$/.test(sandboxId)) {
      return errorJson('Invalid sandbox ID format', 'invalid_request', 400);
    }

    const token = c.env.SANDBOX_API_KEY as string | undefined;
    if (token) {
      const authHeader = c.req.header('Authorization') ?? '';
      const provided = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7)
        : '';
      if (provided !== token) {
        return errorJson('Unauthorized', 'unauthorized', 401);
      }
    }
    return next();
  });

  // ------------------------------------------------------------------
  // POST /sandbox
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox`, async (c) => {
    // Auth — same logic as the /sandbox/* middleware
    const token = c.env.SANDBOX_API_KEY as string | undefined;
    if (token) {
      const authHeader = c.req.header('Authorization') ?? '';
      const provided = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7)
        : '';
      if (provided !== token) {
        return errorJson('Unauthorized', 'unauthorized', 401);
      }
    }

    // Generate a sandbox ID: 16 random bytes → base32 (lowercase a-z, 2-7), 26 chars
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = base32Encode(bytes);
    return c.json({ id });
  });

  // ------------------------------------------------------------------
  // Pool resolution middleware — maps sandbox ID to container UUID
  // ------------------------------------------------------------------

  app.use(`${apiPrefix}/sandbox/:id/*`, async (c, next) => {
    const sandboxId = c.req.param('id');

    const warmTarget =
      Number.parseInt((c.env.WARM_POOL_TARGET as string) || '0', 10) || 0;
    const refreshInterval =
      Number.parseInt(
        (c.env.WARM_POOL_REFRESH_INTERVAL as string) || '10000',
        10
      ) || 10_000;

    const poolNs = getWarmPoolNs(c.env);
    const poolId = poolNs.idFromName('global-pool');
    const poolStub = poolNs.get(poolId);

    try {
      await (poolStub as any).configure({ warmTarget, refreshInterval });
      const containerUUID = await (poolStub as any).getContainer(sandboxId);
      c.set('containerUUID', containerUUID);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('instance limit reached')) {
        return errorJson(msg, 'capacity_exceeded', 503);
      }
      return errorJson(`pool error: ${msg}`, 'pool_error', 502);
    }

    return next();
  });

  // Pool resolution for bare DELETE /sandbox/:id (no trailing path).
  // Uses lookupContainer() to avoid allocating a container just to destroy it.
  app.use(`${apiPrefix}/sandbox/:id`, async (c, next) => {
    // Pool resolution — only for DELETE (the only bare-path handler)
    if (c.req.method !== 'DELETE') return next();

    const sandboxId = c.req.param('id');

    const poolNs = getWarmPoolNs(c.env);
    const poolId = poolNs.idFromName('global-pool');
    const poolStub = poolNs.get(poolId);

    // Lookup only — don't allocate a new container just to destroy it
    try {
      const containerUUID = await (poolStub as any).lookupContainer(sandboxId);
      if (!containerUUID) {
        // No container exists for this sandbox — nothing to destroy
        return new Response(null, { status: 204 });
      }
      c.set('containerUUID', containerUUID);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`pool error: ${msg}`, 'pool_error', 502);
    }

    return next();
  });

  // ------------------------------------------------------------------
  // POST /sandbox/:id/exec
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/exec`, async (c) => {
    let body: ExecRequest;
    try {
      body = await c.req.json<ExecRequest>();
    } catch {
      return errorJson('Invalid JSON body', 'invalid_request', 400);
    }

    if (!Array.isArray(body.argv) || body.argv.length === 0) {
      return errorJson(
        'argv must be a non-empty array',
        'invalid_request',
        400
      );
    }

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));
    const rawSessionId = c.req.header('Session-Id');
    let executor:
      | BridgeSandbox
      | Awaited<ReturnType<BridgeSandbox['getSession']>> = sandbox;
    if (rawSessionId) {
      const sessionId = validateSessionId(rawSessionId);
      if (!sessionId)
        return errorJson('Invalid session ID format', 'invalid_request', 400);
      executor = await sandbox.getSession(sessionId);
    }

    const command = body.argv.map(shellQuote).join(' ');

    const opts: { timeout?: number; cwd?: string } = {};
    if (typeof body.timeout_ms === 'number') {
      opts.timeout = body.timeout_ms;
    }
    if (typeof body.cwd === 'string') {
      const resolvedCwd = resolveWorkspacePath(body.cwd);
      if (!resolvedCwd) {
        return errorJson(
          'cwd must resolve to a location within /workspace',
          'invalid_request',
          403
        );
      }
      opts.cwd = resolvedCwd;
    }

    // --- SSE streaming response ---
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let closed = false;
    let lastWrite: Promise<void> = Promise.resolve();

    /** Write a single SSE event. Chains on the previous write to respect backpressure. */
    function writeSSE(event: string, data: string): void {
      if (closed) return;
      // SSE spec: each line of data needs its own "data:" prefix
      const payload = data
        .split('\n')
        .map((line) => `data: ${line}`)
        .join('\n');
      lastWrite = lastWrite.then(() =>
        writer.write(encoder.encode(`event: ${event}\n${payload}\n\n`))
      );
    }

    function closeStream(): void {
      if (closed) return;
      closed = true;
      lastWrite.then(() => writer.close()).catch(() => {});
    }

    executor
      .exec(command, {
        ...opts,
        stream: true,
        onOutput(stream: 'stdout' | 'stderr', data: string) {
          writeSSE(stream, toBase64(data));
        },
        onComplete(result: { exitCode: number }) {
          writeSSE('exit', JSON.stringify({ exit_code: result.exitCode }));
          closeStream();
        },
        onError(err: Error) {
          writeSSE(
            'error',
            JSON.stringify({ error: err.message, code: 'exec_error' })
          );
          closeStream();
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        writeSSE(
          'error',
          JSON.stringify({
            error: `exec failed: ${msg}`,
            code: 'exec_transport_error'
          })
        );
        closeStream();
      });

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    });
  });

  // ------------------------------------------------------------------
  // GET /sandbox/:id/file/*
  // ------------------------------------------------------------------

  app.get(`${apiPrefix}/sandbox/:id/file/*`, async (c) => {
    const sandboxId = c.req.param('id');

    // Extract everything after /file/ in the URL path
    const fullPath = c.req.path;
    const marker = `${apiPrefix}/sandbox/${sandboxId}/file/`;
    const relativePath = fullPath.slice(marker.length);

    if (!relativePath) {
      return errorJson('file path must not be empty', 'invalid_request', 400);
    }

    // Prepend / to make it absolute before validation
    const resolvedPath = resolveWorkspacePath(`/${relativePath}`);
    if (!resolvedPath) {
      return errorJson(
        'path must resolve to a location within /workspace',
        'invalid_request',
        403
      );
    }

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));
    const rawSessionId = c.req.header('Session-Id');
    let executor:
      | BridgeSandbox
      | Awaited<ReturnType<BridgeSandbox['getSession']>> = sandbox;
    if (rawSessionId) {
      const sessionId = validateSessionId(rawSessionId);
      if (!sessionId)
        return errorJson('Invalid session ID format', 'invalid_request', 400);
      executor = await sandbox.getSession(sessionId);
    }

    try {
      const stream = await executor.readFileStream(resolvedPath);
      return new Response(sseToByteStream(stream), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'FILE_NOT_FOUND') {
        return errorJson(
          `File not found: ${resolvedPath}`,
          'workspace_read_not_found',
          404
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`read failed: ${msg}`, 'exec_transport_error', 502);
    }
  });

  // ------------------------------------------------------------------
  // PUT /sandbox/:id/file/*
  // ------------------------------------------------------------------

  app.put(`${apiPrefix}/sandbox/:id/file/*`, async (c) => {
    const sandboxId = c.req.param('id');

    // Extract everything after /file/ in the URL path
    const fullPath = c.req.path;
    const marker = `${apiPrefix}/sandbox/${sandboxId}/file/`;
    const relativePath = fullPath.slice(marker.length);

    if (!relativePath) {
      return errorJson('file path must not be empty', 'invalid_request', 400);
    }

    // Prepend / to make it absolute before validation
    const resolvedPath = resolveWorkspacePath(`/${relativePath}`);
    if (!resolvedPath) {
      return errorJson(
        'path must resolve to a location within /workspace',
        'invalid_request',
        403
      );
    }

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));
    const rawSessionId = c.req.header('Session-Id');
    let executor:
      | BridgeSandbox
      | Awaited<ReturnType<BridgeSandbox['getSession']>> = sandbox;
    if (rawSessionId) {
      const sessionId = validateSessionId(rawSessionId);
      if (!sessionId)
        return errorJson('Invalid session ID format', 'invalid_request', 400);
      executor = await sandbox.getSession(sessionId);
    }

    try {
      const buffer = await c.req.arrayBuffer();
      const MAX_WRITE_BYTES = 32 * 1024 * 1024; // 32 MiB — matches RPC payload limit
      if (buffer.byteLength > MAX_WRITE_BYTES) {
        return errorJson(
          `payload too large: ${buffer.byteLength} bytes exceeds the ${MAX_WRITE_BYTES}-byte limit`,
          'payload_too_large',
          413
        );
      }

      const bytes = new Uint8Array(buffer);
      let b64 = '';
      const CHUNK = 6144; // 6144 = 3 * 2048 — no intermediate padding
      for (let i = 0; i < bytes.length; i += CHUNK) {
        b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
      }
      await executor.writeFile(resolvedPath, b64, { encoding: 'base64' });
      const response: WriteResponse = { ok: true };
      return c.json(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(
        `write failed: ${msg}`,
        'workspace_archive_write_error',
        502
      );
    }
  });

  // ------------------------------------------------------------------
  // GET /sandbox/:id/running
  // ------------------------------------------------------------------

  app.get(`${apiPrefix}/sandbox/:id/running`, async (c) => {
    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));

    try {
      await sandbox.exec('true');
      const response: RunningResponse = { running: true };
      return c.json(response);
    } catch {
      const response: RunningResponse = { running: false };
      return c.json(response);
    }
  });

  // ------------------------------------------------------------------
  // GET /sandbox/:id/pty (WebSocket upgrade)
  // ------------------------------------------------------------------

  app.get(`${apiPrefix}/sandbox/:id/pty`, async (c) => {
    // 1. Require WebSocket upgrade
    const upgrade = c.req.header('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return errorJson('WebSocket upgrade required', 'invalid_request', 400);
    }

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));

    // 2. Parse PtyOptions from query params
    const colsParam = c.req.query('cols');
    const rowsParam = c.req.query('rows');
    const shell = c.req.query('shell');
    const sessionId = c.req.header('Session-Id') || c.req.query('session');

    const cols = colsParam ? Number(colsParam) : 80;
    const rows = rowsParam ? Number(rowsParam) : 24;

    if (Number.isNaN(cols) || Number.isNaN(rows)) {
      return errorJson(
        'cols and rows must be valid numbers',
        'invalid_request',
        400
      );
    }

    const opts: PtyOptions = { cols, rows };
    if (shell) {
      opts.shell = shell;
    }

    try {
      if (sessionId) {
        const validatedId = validateSessionId(sessionId);
        if (!validatedId)
          return errorJson('Invalid session ID format', 'invalid_request', 400);
        const sess = await sandbox.getSession(validatedId);
        return await sess.terminal(c.req.raw, opts);
      }
      return await sandbox.terminal(c.req.raw, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`terminal failed: ${msg}`, 'exec_transport_error', 502);
    }
  });

  // ------------------------------------------------------------------
  // POST /sandbox/:id/persist
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/persist`, async (c) => {
    const root = '/workspace';

    // Decode any exclude paths passed from the client layer.
    const excludesParam = c.req.query('excludes') ?? '';
    const excludes = excludesParam
      ? excludesParam.split(',').filter((s) => s.length > 0)
      : [];

    // Validate excludes don't contain path traversal
    for (const ex of excludes) {
      if (ex.includes('..')) {
        return errorJson(
          'exclude paths must not contain ".."',
          'invalid_request',
          400
        );
      }
    }

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));

    const tmpPath = `/tmp/sandbox-persist-${Date.now()}.tar`;
    const excludeArgs = excludes
      .map((rel) => `--exclude ${shellQuote(`./${rel.replace(/^\.\//, '')}`)}`)
      .join(' ');
    const tarCmd = excludeArgs
      ? `tar cf ${shellQuote(tmpPath)} ${excludeArgs} -C ${shellQuote(root)} .`
      : `tar cf ${shellQuote(tmpPath)} -C ${shellQuote(root)} .`;

    try {
      const result = await sandbox.exec(tarCmd);

      if (result.exitCode !== 0) {
        return errorJson(
          `tar failed (exit ${result.exitCode}): ${result.stderr}`,
          'workspace_archive_read_error',
          502
        );
      }

      const stream = await sandbox.readFileStream(tmpPath);

      // Best-effort cleanup; don't await so we don't delay the response.
      sandbox.exec(`rm -f ${shellQuote(tmpPath)}`).catch(() => {});

      return new Response(sseToByteStream(stream), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(
        `persist failed: ${msg}`,
        'workspace_archive_read_error',
        502
      );
    }
  });

  // ------------------------------------------------------------------
  // POST /sandbox/:id/hydrate
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/hydrate`, async (c) => {
    const root = '/workspace';

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));

    // Read the raw tar bytes from the request body.
    let tarBytes: Uint8Array;
    try {
      const buffer = await c.req.arrayBuffer();
      tarBytes = new Uint8Array(buffer);
    } catch {
      return errorJson('Could not read request body', 'invalid_request', 400);
    }

    if (tarBytes.byteLength === 0) {
      return errorJson('Empty tar payload', 'invalid_request', 400);
    }

    const MAX_HYDRATE_BYTES = 32 * 1024 * 1024; // 32 MiB
    if (tarBytes.byteLength > MAX_HYDRATE_BYTES) {
      return errorJson(
        `tar payload too large: ${tarBytes.byteLength} bytes exceeds the ${MAX_HYDRATE_BYTES}-byte limit`,
        'invalid_request',
        400
      );
    }

    try {
      await sandbox.exec(`mkdir -p ${shellQuote(root)}`);

      const tmpPath = `/tmp/sandbox-hydrate-${Date.now()}.tar`;

      let b64 = '';
      const CHUNK = 6144; // 6144 = 3 * 2048 — no intermediate padding
      for (let i = 0; i < tarBytes.length; i += CHUNK) {
        b64 += btoa(String.fromCharCode(...tarBytes.subarray(i, i + CHUNK)));
      }
      await sandbox.writeFile(tmpPath, b64, { encoding: 'base64' });

      const extractResult = await sandbox.exec(
        `tar xf ${shellQuote(tmpPath)} -C ${shellQuote(root)} && rm -f ${shellQuote(tmpPath)}`
      );
      if (extractResult.exitCode !== 0) {
        return errorJson(
          `tar extract failed (exit ${extractResult.exitCode}): ${extractResult.stderr}`,
          'workspace_archive_write_error',
          502
        );
      }

      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(
        `hydrate failed: ${msg}`,
        'workspace_archive_write_error',
        502
      );
    }
  });

  // ------------------------------------------------------------------
  // POST /sandbox/:id/mount
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/mount`, async (c) => {
    let body: MountBucketRequest;
    try {
      body = await c.req.json<MountBucketRequest>();
    } catch {
      return errorJson('Invalid JSON body', 'invalid_request', 400);
    }

    if (!body.bucket || typeof body.bucket !== 'string') {
      return errorJson(
        'bucket must be a non-empty string',
        'invalid_request',
        400
      );
    }
    if (!body.mountPath || typeof body.mountPath !== 'string') {
      return errorJson(
        'mountPath must be a non-empty string',
        'invalid_request',
        400
      );
    }
    if (!body.mountPath.startsWith('/')) {
      return errorJson(
        'mountPath must be an absolute path (start with /)',
        'invalid_request',
        400
      );
    }
    if (!body.options || typeof body.options !== 'object') {
      return errorJson('options must be an object', 'invalid_request', 400);
    }
    if (!body.options.endpoint || typeof body.options.endpoint !== 'string') {
      return errorJson(
        'options.endpoint must be a non-empty string',
        'invalid_request',
        400
      );
    }

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));

    const sdkOptions: {
      endpoint: string;
      readOnly?: boolean;
      prefix?: string;
      credentials?: { accessKeyId: string; secretAccessKey: string };
    } = {
      endpoint: body.options.endpoint
    };

    if (body.options.readOnly !== undefined) {
      sdkOptions.readOnly = body.options.readOnly;
    }
    if (body.options.prefix !== undefined) {
      sdkOptions.prefix = body.options.prefix;
    }
    if (body.options.credentials) {
      sdkOptions.credentials = {
        accessKeyId: body.options.credentials.accessKeyId,
        secretAccessKey: body.options.credentials.secretAccessKey
      };
    }

    try {
      await sandbox.mountBucket(body.bucket, body.mountPath, sdkOptions);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`mount failed: ${msg}`, 'mount_error', 502);
    }
  });

  // ------------------------------------------------------------------
  // POST /sandbox/:id/unmount
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/unmount`, async (c) => {
    let body: UnmountBucketRequest;
    try {
      body = await c.req.json<UnmountBucketRequest>();
    } catch {
      return errorJson('Invalid JSON body', 'invalid_request', 400);
    }

    if (!body.mountPath || typeof body.mountPath !== 'string') {
      return errorJson(
        'mountPath must be a non-empty string',
        'invalid_request',
        400
      );
    }
    if (!body.mountPath.startsWith('/')) {
      return errorJson(
        'mountPath must be an absolute path (start with /)',
        'invalid_request',
        400
      );
    }

    // Normalize to resolve '..' / '.' segments, then reject the filesystem
    // root so the post-unmount rm -rf cleanup cannot be destructive.
    const normalizedPath = new URL(body.mountPath, 'file:///').pathname;
    if (normalizedPath === '/') {
      return errorJson(
        'mountPath must not resolve to / (filesystem root)',
        'invalid_request',
        400
      );
    }

    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));

    try {
      await sandbox.unmountBucket(normalizedPath);

      // The SDK unmounts the filesystem but does not remove the mount point
      // directory. Verify the path is no longer an active mount before removing
      // it — if fusermount failed silently we must not delete bucket contents.
      const quoted = shellQuote(normalizedPath);
      try {
        await sandbox.exec(`mountpoint -q ${quoted} || rmdir ${quoted}`);
      } catch {
        // Best-effort — the unmount itself already succeeded
      }

      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`unmount failed: ${msg}`, 'unmount_error', 502);
    }
  });

  // ------------------------------------------------------------------
  // POST /sandbox/:id/session
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/session`, async (c) => {
    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));

    let body: { id?: string; cwd?: string; env?: Record<string, string> } = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is fine — all fields are optional
    }

    try {
      const session = await sandbox.createSession(body);
      return c.json({ id: session.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`session create failed: ${msg}`, 'session_error', 502);
    }
  });

  // ------------------------------------------------------------------
  // DELETE /sandbox/:id/session/:sid
  // ------------------------------------------------------------------

  app.delete(`${apiPrefix}/sandbox/:id/session/:sid`, async (c) => {
    const sandbox = getSandbox(getSandboxNs(c.env), c.get('containerUUID'));
    const sid = c.req.param('sid');

    try {
      const result = await sandbox.deleteSession(sid);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`session delete failed: ${msg}`, 'session_error', 502);
    }
  });

  // ------------------------------------------------------------------
  // DELETE /sandbox/:id
  // ------------------------------------------------------------------

  app.delete(`${apiPrefix}/sandbox/:id`, async (c) => {
    const containerUUID = c.get('containerUUID');
    const sandbox = getSandbox(getSandboxNs(c.env), containerUUID);

    try {
      await sandbox.destroy();
    } catch {
      // Best-effort — container may already be gone
    }

    // Release the WarmPool assignment so it doesn't track a dead container
    try {
      const poolNs = getWarmPoolNs(c.env);
      const poolId = poolNs.idFromName('global-pool');
      const poolStub = poolNs.get(poolId);
      await (poolStub as any).reportStopped(containerUUID);
    } catch {
      // Best-effort
    }

    return new Response(null, { status: 204 });
  });

  // ------------------------------------------------------------------
  // Health check
  // ------------------------------------------------------------------

  app.get(config.healthPath, (c) => {
    const errors: string[] = [];

    if (!c.env[sandboxBinding]) {
      errors.push(
        `Missing required Durable Object binding "${sandboxBinding}". Ensure your wrangler.jsonc has a binding named "${sandboxBinding}".`
      );
    }
    if (!c.env[warmPoolBinding]) {
      errors.push(
        `Missing required Durable Object binding "${warmPoolBinding}". Ensure your wrangler.jsonc has a binding named "${warmPoolBinding}".`
      );
    }

    if (errors.length > 0) {
      return c.json({ ok: false, errors }, 503);
    }

    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------
  // Pool management routes
  // ------------------------------------------------------------------

  app.use(`${apiPrefix}/pool/*`, async (c, next) => {
    const token = c.env.SANDBOX_API_KEY as string | undefined;
    if (token) {
      const authHeader = c.req.header('Authorization') ?? '';
      const provided = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : '';
      if (provided !== token) {
        return errorJson('Unauthorized', 'unauthorized', 401);
      }
    }
    return next();
  });

  app.get(`${apiPrefix}/pool/stats`, async (c) => {
    const warmTarget =
      Number.parseInt((c.env.WARM_POOL_TARGET as string) || '0', 10) || 0;
    const refreshInterval =
      Number.parseInt(
        (c.env.WARM_POOL_REFRESH_INTERVAL as string) || '10000',
        10
      ) || 10_000;

    const poolNs = getWarmPoolNs(c.env);
    const poolId = poolNs.idFromName('global-pool');
    const poolStub = poolNs.get(poolId);

    try {
      await (poolStub as any).configure({ warmTarget, refreshInterval });
    } catch {
      // Continue — stats should still be readable even if config push fails.
    }

    const stats = await (poolStub as any).getStats();
    return c.json(stats);
  });

  app.post(`${apiPrefix}/pool/shutdown-prewarmed`, async (c) => {
    const warmTarget =
      Number.parseInt((c.env.WARM_POOL_TARGET as string) || '0', 10) || 0;
    const refreshInterval =
      Number.parseInt(
        (c.env.WARM_POOL_REFRESH_INTERVAL as string) || '10000',
        10
      ) || 10_000;

    const poolNs = getWarmPoolNs(c.env);
    const poolId = poolNs.idFromName('global-pool');
    const poolStub = poolNs.get(poolId);

    try {
      await (poolStub as any).configure({ warmTarget, refreshInterval });
    } catch {
      // Continue.
    }

    await (poolStub as any).shutdownPrewarmed();
    return c.json({ ok: true });
  });

  app.post(`${apiPrefix}/pool/prime`, async (c) => {
    await primePool(c.env, warmPoolBinding);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------
  // OpenAPI routes
  // ------------------------------------------------------------------

  const openapiAuth: MiddlewareHandler<{ Bindings: BridgeEnv }> = async (
    c,
    next
  ) => {
    const token = c.env.SANDBOX_API_KEY as string | undefined;
    if (token) {
      const authHeader = c.req.header('Authorization') ?? '';
      const provided = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : '';
      // Also accept the API key as a ?token= query parameter so browsers
      // and tools can load the spec without custom headers.
      const queryToken = c.req.query('token') ?? '';
      if (provided !== token && queryToken !== token) {
        return errorJson('Unauthorized', 'unauthorized', 401);
      }
    }
    return next();
  };

  const openapiHtmlHandler = () =>
    new Response(renderOpenApiHtml(OPENAPI_SCHEMA as Record<string, unknown>), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });

  app.get(`${apiPrefix}/openapi.json`, openapiAuth, (c) =>
    c.json(OPENAPI_SCHEMA)
  );
  app.get(`${apiPrefix}/openapi.html`, openapiAuth, openapiHtmlHandler);
  app.get(`${apiPrefix}/openapi`, openapiAuth, openapiHtmlHandler);

  return app;
}
