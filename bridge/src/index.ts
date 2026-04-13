/**
 * cloudflare-sandbox-bridge — Cloudflare Sandbox Worker
 *
 * Exposes an HTTP API consumed by the Python `CloudflareSandboxClient` and
 * forwards each operation to a named Cloudflare Sandbox Durable Object via
 * the `@cloudflare/sandbox` SDK.
 *
 * API surface mirrors the abstract methods on `BaseSandboxSession`:
 *
 *   POST   /v1/sandbox/:id/exec      _exec_internal  → run a command, return ExecResult
 *   GET    /v1/sandbox/:id/file/*    read            → stream file bytes
 *   PUT    /v1/sandbox/:id/file/*    write           → write file bytes
 *   GET    /v1/sandbox/:id/running   running         → {"running": bool}
 *   POST   /v1/sandbox/:id/persist   persist_workspace → raw tar stream
 *   POST   /v1/sandbox/:id/hydrate   hydrate_workspace ← raw tar stream
 *   POST   /v1/sandbox/:id/mount     mountBucket     → mount S3-compatible bucket
 *   POST   /v1/sandbox/:id/unmount   unmountBucket   → unmount a mounted bucket
 *   DELETE /v1/sandbox/:id           shutdown        → best-effort sandbox destroy
 *
 * Authentication
 * --------------
 * Every request must carry:
 *   Authorization: Bearer <SANDBOX_API_KEY>
 *
 * The /openapi.* routes also accept the key as a query parameter:
 *   /openapi.json?token=<SANDBOX_API_KEY>
 *
 * Set the token with:
 *   wrangler secret put SANDBOX_API_KEY
 *
 * During local `wrangler dev` you can set it in a `.dev.vars` file:
 *   SANDBOX_API_KEY=dev-secret
 */

import type { ExecutionSession, ISandbox, PtyOptions } from '@cloudflare/sandbox';
import { getSandbox as _getSandbox, proxyToSandbox } from '@cloudflare/sandbox';
import { Hono, type MiddlewareHandler } from 'hono';

/**
 * The SDK's getSandbox() proxy exposes methods not declared on ISandbox
 * (terminal, destroy) or declared with a narrower return type (getSession
 * without terminal). This type extends ISandbox with those extra methods
 * so call sites get type safety without per-call casts.
 */
type BridgeSandbox = ISandbox & {
  terminal(request: Request, options?: PtyOptions): Promise<Response>;
  getSession(
    sessionId: string
  ): Promise<ExecutionSession & { terminal(request: Request, options?: PtyOptions): Promise<Response> }>;
  destroy(): Promise<void>;
};

/** Typed wrapper around the SDK's getSandbox() that returns a BridgeSandbox. */
function getSandbox(ns: DurableObjectNamespace, containerUUID: string): BridgeSandbox {
  return _getSandbox(ns, containerUUID) as unknown as BridgeSandbox;
}

import { OPENAPI_SCHEMA } from './openapi';
import { renderOpenApiHtml } from './openapi-html';

// Re-export Sandbox so Wrangler can wire up the Durable Object binding.
export { Sandbox } from '@cloudflare/sandbox';

// Re-export WarmPool so Wrangler can wire up its Durable Object binding.
export { WarmPool } from './warm-pool';

// ---------------------------------------------------------------------------
// JSON wire types shared between the Python client and this worker
// ---------------------------------------------------------------------------

/** Sent by the Python client for /exec requests. */
interface ExecRequest {
  /** Argv array — already shell-expanded by the Python layer if shell=True. */
  argv: string[];
  /** Per-call timeout in milliseconds (optional). */
  timeout_ms?: number;
  /** Working directory for the command (optional, defaults to sandbox cwd). */
  cwd?: string;
}

/** Returned by /write on success. */
interface WriteResponse {
  ok: true;
}

/** Returned by /running. */
interface RunningResponse {
  running: boolean;
}

/** Returned by all error paths. */
interface ErrorResponse {
  error: string;
  /** Stable machine-readable code; mirrors UC ErrorCode values where possible. */
  code: string;
}

/** Credentials for mounting an S3-compatible bucket. */
interface MountBucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Options nested inside a MountBucketRequest. */
interface MountBucketRequestOptions {
  /** S3-compatible endpoint URL (required). */
  endpoint: string;
  /** Mount filesystem as read-only (default: false). */
  readOnly?: boolean;
  /** Optional prefix/subdirectory within the bucket to mount. */
  prefix?: string;
  /** Explicit credentials. Omit to use auto-detected Worker secrets. */
  credentials?: MountBucketCredentials;
}

/** Sent by the Python client for /mount requests. */
interface MountBucketRequest {
  /** Bucket name. */
  bucket: string;
  /** Absolute path in the container to mount at. */
  mountPath: string;
  /** Mount configuration. */
  options: MountBucketRequestOptions;
}

/** Sent by the Python client for /unmount requests. */
interface UnmountBucketRequest {
  /** Absolute path where the bucket is currently mounted. */
  mountPath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * UTF-8-safe base64 encoding.
 * btoa() only handles latin-1; encode to UTF-8 bytes first via TextEncoder.
 */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** RFC 4648 base32 encoding (lowercase). Returns only [a-z2-7]. */
function base32Encode(data: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function errorJson(error: string, code: string, status: number): Response {
  const body: ErrorResponse = { error, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Shell-quote a single argv token so it is safe to embed in a sh command
 * string.  Tokens that contain only safe characters are returned unchanged
 * for readability.  All others are wrapped in ANSI-C $'...' quoting which
 * can represent newlines, tabs, and other control characters as escape
 * sequences — unlike plain single quotes which pass content literally and
 * break when the value contains a real newline.
 */
export function shellQuote(arg: string): string {
  // Fast path: arg contains only safe characters.
  if (/^[A-Za-z0-9@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  // Use $'...' (ANSI-C quoting) which supports escape sequences.
  // Escape backslashes first, then single quotes and control characters.
  const escaped = arg
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return "$'" + escaped + "'";
}

/**
 * POSIX-normalise a path (resolve `.` / `..` segments) and verify it lives
 * under /workspace.  Returns the resolved absolute path on success, or null
 * if the path escapes the workspace.
 */
export function resolveWorkspacePath(userPath: string): string | null {
  // Treat relative paths as relative to /workspace
  const abs = userPath.startsWith('/') ? userPath : `/workspace/${userPath}`;

  // Normalise: split on '/', resolve '.' and '..'
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const resolved = '/' + parts.join('/');

  // Must be exactly /workspace or start with /workspace/
  if (resolved === '/workspace' || resolved.startsWith('/workspace/')) {
    return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hono application
// ---------------------------------------------------------------------------

export const app = new Hono<{ Bindings: Env; Variables: { containerUUID: string } }>();

// ------------------------------------------------------------------
// Auth middleware — applies to all /sandbox/* routes
// ------------------------------------------------------------------

app.use('/v1/sandbox/*', async (c, next) => {
  // Validate sandbox ID format
  const url = new URL(c.req.url);
  const pathParts = url.pathname.split('/');
  // Path is /v1/sandbox/:id/... so ID is at index 3
  const sandboxId = pathParts[3];
  if (sandboxId && !/^[a-z2-7]{1,128}$/.test(sandboxId)) {
    return errorJson('Invalid sandbox ID format', 'invalid_request', 400);
  }

  const token = c.env.SANDBOX_API_KEY;
  if (token) {
    const authHeader = c.req.header('Authorization') ?? '';
    const provided = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
    if (provided !== token) {
      return errorJson('Unauthorized', 'unauthorized', 401);
    }
  } else {
    console.warn(
      '[security] SANDBOX_API_KEY is not set — auth is disabled. Set via `wrangler secret put SANDBOX_API_KEY`.'
    );
  }
  return next();
});

// ------------------------------------------------------------------
// POST /sandbox
//
// Creates a new sandbox session and returns its ID. The ID is a
// random UUID-based token that matches the [a-zA-Z0-9_-]{1,128}
// format required by all /sandbox/:id/* routes.
//
// Response: {"id": "<sandbox-id>"}
// ------------------------------------------------------------------

app.post('/v1/sandbox', async (c) => {
  // Auth — same logic as the /sandbox/* middleware
  const token = c.env.SANDBOX_API_KEY;
  if (token) {
    const authHeader = c.req.header('Authorization') ?? '';
    const provided = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
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

app.use('/v1/sandbox/:id/*', async (c, next) => {
  const sandboxId = c.req.param('id');

  const warmTarget = Number.parseInt(c.env.WARM_POOL_TARGET || '0', 10) || 0;
  const refreshInterval = Number.parseInt(c.env.WARM_POOL_REFRESH_INTERVAL || '10000', 10) || 10_000;

  const poolId = c.env.WARM_POOL.idFromName('global-pool');
  const poolStub = c.env.WARM_POOL.get(poolId);

  try {
    await poolStub.configure({ warmTarget, refreshInterval });
    const containerUUID = await poolStub.getContainer(sandboxId);
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

// Also handle the bare DELETE /v1/sandbox/:id route (no trailing path)
app.use('/v1/sandbox/:id', async (c, next) => {
  // Only apply pool resolution for methods that need it
  if (c.req.method !== 'DELETE') return next();

  const sandboxId = c.req.param('id');

  const warmTarget = Number.parseInt(c.env.WARM_POOL_TARGET || '0', 10) || 0;
  const refreshInterval = Number.parseInt(c.env.WARM_POOL_REFRESH_INTERVAL || '10000', 10) || 10_000;

  const poolId = c.env.WARM_POOL.idFromName('global-pool');
  const poolStub = c.env.WARM_POOL.get(poolId);

  try {
    await poolStub.configure({ warmTarget, refreshInterval });
    const containerUUID = await poolStub.getContainer(sandboxId);
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

// ------------------------------------------------------------------
// POST /sandbox/:id/exec
//
// Body: ExecRequest (JSON)
// Response: Server-Sent Events stream (text/event-stream)
//
// SSE events:
//   event: stdout   data: <base64 chunk>
//   event: stderr   data: <base64 chunk>
//   event: exit     data: {"exit_code": N}        (terminal)
//   event: error    data: {"error":"…","code":"…"} (terminal)
// ------------------------------------------------------------------

app.post('/v1/sandbox/:id/exec', async (c) => {
  let body: ExecRequest;
  try {
    body = await c.req.json<ExecRequest>();
  } catch {
    return errorJson('Invalid JSON body', 'invalid_request', 400);
  }

  if (!Array.isArray(body.argv) || body.argv.length === 0) {
    return errorJson('argv must be a non-empty array', 'invalid_request', 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

  // The Python layer sends argv as a proper array, e.g.:
  //   ["sh", "-lc", "mkdir -p /workspace"]
  // We must shell-quote each element before joining so that the shell
  // invoked by sandbox.exec() receives them as distinct arguments.
  const command = body.argv.map(shellQuote).join(' ');

  const opts: { timeout?: number; cwd?: string } = {};
  if (typeof body.timeout_ms === 'number') {
    opts.timeout = body.timeout_ms;
  }
  if (typeof body.cwd === 'string') {
    const resolvedCwd = resolveWorkspacePath(body.cwd);
    if (!resolvedCwd) {
      return errorJson('cwd must resolve to a location within /workspace', 'invalid_request', 403);
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
    lastWrite = lastWrite.then(() => writer.write(encoder.encode(`event: ${event}\n${payload}\n\n`)));
  }

  function closeStream(): void {
    if (closed) return;
    closed = true;
    lastWrite.then(() => writer.close()).catch(() => {});
  }

  sandbox
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
        writeSSE('error', JSON.stringify({ error: err.message, code: 'exec_error' }));
        closeStream();
      }
    })
    .catch((err: unknown) => {
      // If the promise rejects and onError was not already called, send a
      // single error event before closing.
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
//
// Reads a file from the sandbox filesystem. The file path is encoded
// in the URL after /file/ (e.g. /sandbox/abc/file/workspace/main.py).
//
// Response: raw file bytes streamed via readFileStream()
// ------------------------------------------------------------------

app.get('/v1/sandbox/:id/file/*', async (c) => {
  const sandboxId = c.req.param('id');

  // Extract everything after /file/ in the URL path
  const fullPath = c.req.path;
  const marker = `/v1/sandbox/${sandboxId}/file/`;
  const relativePath = fullPath.slice(marker.length);

  if (!relativePath) {
    return errorJson('file path must not be empty', 'invalid_request', 400);
  }

  // Prepend / to make it absolute before validation
  const resolvedPath = resolveWorkspacePath('/' + relativePath);
  if (!resolvedPath) {
    return errorJson('path must resolve to a location within /workspace', 'invalid_request', 403);
  }

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

  try {
    const stream = await sandbox.readFileStream(resolvedPath);
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FILE_NOT_FOUND') {
      return errorJson(`File not found: ${resolvedPath}`, 'workspace_read_not_found', 404);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorJson(`read failed: ${msg}`, 'exec_transport_error', 502);
  }
});

// ------------------------------------------------------------------
// PUT /sandbox/:id/file/*
//
// Writes a file into the sandbox filesystem. The file path is encoded
// in the URL after /file/ (e.g. /sandbox/abc/file/workspace/main.py).
// The raw request body is treated as binary: it is base64-encoded and
// written via writeFile({ encoding: 'base64' }) so non-UTF-8 payloads
// (images, archives, compiled binaries) survive the round-trip.
//
// The underlying RPC layer has a ~32 MiB payload limit. Requests that
// exceed it are rejected with a 413 before reaching the sandbox.
//
// Response: {"ok": true} on success
// ------------------------------------------------------------------

app.put('/v1/sandbox/:id/file/*', async (c) => {
  const sandboxId = c.req.param('id');

  // Extract everything after /file/ in the URL path
  const fullPath = c.req.path;
  const marker = `/v1/sandbox/${sandboxId}/file/`;
  const relativePath = fullPath.slice(marker.length);

  if (!relativePath) {
    return errorJson('file path must not be empty', 'invalid_request', 400);
  }

  // Prepend / to make it absolute before validation
  const resolvedPath = resolveWorkspacePath('/' + relativePath);
  if (!resolvedPath) {
    return errorJson('path must resolve to a location within /workspace', 'invalid_request', 403);
  }

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

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

    // Base64-encode the raw bytes so binary payloads survive the string-based
    // writeFile RPC. The container decodes via Buffer.from(b64, 'base64').
    // Chunk size must be a multiple of 3 so intermediate chunks produce clean
    // base64 without padding; only the final chunk may have trailing '='.
    const bytes = new Uint8Array(buffer);
    let b64 = '';
    const CHUNK = 6144; // 6144 = 3 * 2048 — no intermediate padding
    for (let i = 0; i < bytes.length; i += CHUNK) {
      b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
    }
    await sandbox.writeFile(resolvedPath, b64, { encoding: 'base64' });
    const response: WriteResponse = { ok: true };
    return c.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorJson(`write failed: ${msg}`, 'workspace_archive_write_error', 502);
  }
});

// ------------------------------------------------------------------
// GET /sandbox/:id/running
//
// Response: {"running": bool}
// We treat a successful no-op exec as "running"; a failed one as "not running".
// ------------------------------------------------------------------

app.get('/v1/sandbox/:id/running', async (c) => {
  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

  try {
    // A simple ping — if the sandbox is awake and healthy this returns quickly.
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
//
// Upgrades the HTTP connection to a WebSocket and proxies it to the
// sandbox SDK's terminal() method. The Worker is a pure pass-through;
// all PTY lifecycle management lives in the SDK / container.
//
// Query params (all optional):
//   cols    — terminal width  (default 80)
//   rows    — terminal height (default 24)
//   shell   — shell binary (e.g. /bin/bash)
//   session — SDK session ID for session-scoped PTY
// ------------------------------------------------------------------

app.get('/v1/sandbox/:id/pty', async (c) => {
  // 1. Require WebSocket upgrade
  const upgrade = c.req.header('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return errorJson('WebSocket upgrade required', 'invalid_request', 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

  // 2. Parse PtyOptions from query params
  const colsParam = c.req.query('cols');
  const rowsParam = c.req.query('rows');
  const shell = c.req.query('shell');
  const session = c.req.query('session');

  const cols = colsParam ? Number(colsParam) : 80;
  const rows = rowsParam ? Number(rowsParam) : 24;

  if (Number.isNaN(cols) || Number.isNaN(rows)) {
    return errorJson('cols and rows must be valid numbers', 'invalid_request', 400);
  }

  const opts: PtyOptions = { cols, rows };
  if (shell) {
    opts.shell = shell;
  }

  try {
    // 3. If a session is specified, get the session and call terminal() on it;
    //    otherwise call terminal() directly on the sandbox.
    if (session) {
      const sess = await sandbox.getSession(session);
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
//
// Serializes the /workspace directory to a tar stream and returns it as
// raw bytes.
//
// Query params (all optional):
//   excludes      — comma-separated list of relative paths to exclude from tar
//
// Response: raw tar bytes (application/octet-stream)
// ------------------------------------------------------------------

app.post('/v1/sandbox/:id/persist', async (c) => {
  const root = '/workspace';

  // Decode any exclude paths passed from the Python layer.
  const excludesParam = c.req.query('excludes') ?? '';
  const excludes = excludesParam ? excludesParam.split(',').filter((s) => s.length > 0) : [];

  // Validate excludes don't contain path traversal
  for (const ex of excludes) {
    if (ex.includes('..')) {
      return errorJson('exclude paths must not contain ".."', 'invalid_request', 400);
    }
  }

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

  // Write the archive to a temp file inside the sandbox rather than capturing
  // it via exec() stdout. The exec() stdout path goes through a UTF-8 log
  // file in the container runtime, which corrupts binary data (bytes > 0x7F
  // are mangled by the UTF-8 decoder). Writing to a file and streaming it
  // back via readFileStream() gives us a clean binary round-trip.
  const tmpPath = `/tmp/sandbox-persist-${Date.now()}.tar`;
  // Each excluded path becomes a --exclude argument rooted at '.'.
  // Shell-quote each exclude to prevent injection
  const excludeArgs = excludes.map((rel) => `--exclude ${shellQuote('./' + rel.replace(/^\.\//, ''))}`).join(' ');
  const tarCmd = excludeArgs
    ? `tar cf ${shellQuote(tmpPath)} ${excludeArgs} -C ${shellQuote(root)} .`
    : `tar cf ${shellQuote(tmpPath)} -C ${shellQuote(root)} .`;

  try {
    const result = await sandbox.exec(tarCmd);

    if (result.exitCode !== 0) {
      return errorJson(`tar failed (exit ${result.exitCode}): ${result.stderr}`, 'workspace_archive_read_error', 502);
    }

    // Stream the tar file back as raw bytes using readFileStream(), which
    // returns a ReadableStream<Uint8Array> — no base64 or string encoding.
    const stream = await sandbox.readFileStream(tmpPath);

    // Best-effort cleanup; don't await so we don't delay the response.
    sandbox.exec(`rm -f ${shellQuote(tmpPath)}`).catch(() => {});

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorJson(`persist failed: ${msg}`, 'workspace_archive_read_error', 502);
  }
});

// ------------------------------------------------------------------
// POST /sandbox/:id/hydrate
//
// Populates /workspace from a tar stream sent as the raw request body.
//
// Response: {"ok": true}
// ------------------------------------------------------------------

app.post('/v1/sandbox/:id/hydrate', async (c) => {
  const root = '/workspace';

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

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

  // sandbox.writeFile() with encoding:'base64' is the only binary write path
  // available without a writeFileStream() API. The underlying RPC has a hard
  // 32 MiB limit (MAX_RPC_FILE_SIZE in the SDK). Reject early with a clear
  // error rather than letting the SDK throw an opaque failure.
  // See Tickets/SBX-1 for the writeFileStream() proposal that would lift this.
  const MAX_HYDRATE_BYTES = 32 * 1024 * 1024; // 32 MiB
  if (tarBytes.byteLength > MAX_HYDRATE_BYTES) {
    return errorJson(
      `tar payload too large: ${tarBytes.byteLength} bytes exceeds the ${MAX_HYDRATE_BYTES}-byte limit`,
      'invalid_request',
      400
    );
  }

  try {
    // Ensure the workspace root exists before extracting.
    await sandbox.exec(`mkdir -p ${shellQuote(root)}`);

    // Write the tar archive to a temp path inside the sandbox,
    // then extract it.  We use a unique temp path to avoid collisions.
    const tmpPath = `/tmp/sandbox-hydrate-${Date.now()}.tar`;

    // Encode the raw bytes as base64 and use writeFile({ encoding: 'base64' })
    // so the container decodes it back to exact bytes via Buffer.from(b64, 'base64').
    // The previous String.fromCharCode approach produced a latin-1 string that
    // writeFile then wrote as UTF-8, double-encoding any byte > 0x7F.
    // Chunk the btoa() call to avoid call-stack overflow on large buffers.
    let b64 = '';
    const CHUNK = 8192;
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
    return errorJson(`hydrate failed: ${msg}`, 'workspace_archive_write_error', 502);
  }
});

// ------------------------------------------------------------------
// POST /sandbox/:id/mount
//
// Mount an S3-compatible bucket as a local directory inside the
// container via s3fs-FUSE. Credentials are optional — the SDK
// auto-detects from Worker secrets when omitted.
//
// Body: MountBucketRequest (JSON)
// Response: {"ok": true}
// ------------------------------------------------------------------

app.post('/v1/sandbox/:id/mount', async (c) => {
  let body: MountBucketRequest;
  try {
    body = await c.req.json<MountBucketRequest>();
  } catch {
    return errorJson('Invalid JSON body', 'invalid_request', 400);
  }

  if (!body.bucket || typeof body.bucket !== 'string') {
    return errorJson('bucket must be a non-empty string', 'invalid_request', 400);
  }
  if (!body.mountPath || typeof body.mountPath !== 'string') {
    return errorJson('mountPath must be a non-empty string', 'invalid_request', 400);
  }
  if (!body.mountPath.startsWith('/')) {
    return errorJson('mountPath must be an absolute path (start with /)', 'invalid_request', 400);
  }
  if (!body.options || typeof body.options !== 'object') {
    return errorJson('options must be an object', 'invalid_request', 400);
  }
  if (!body.options.endpoint || typeof body.options.endpoint !== 'string') {
    return errorJson('options.endpoint must be a non-empty string', 'invalid_request', 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

  // Map the wire format to the SDK's RemoteMountBucketOptions.
  // Provider is intentionally omitted — the SDK auto-detects from the endpoint URL.
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
//
// Unmount a previously mounted bucket filesystem.
//
// Body: UnmountBucketRequest (JSON)
// Response: {"ok": true}
// ------------------------------------------------------------------

app.post('/v1/sandbox/:id/unmount', async (c) => {
  let body: UnmountBucketRequest;
  try {
    body = await c.req.json<UnmountBucketRequest>();
  } catch {
    return errorJson('Invalid JSON body', 'invalid_request', 400);
  }

  if (!body.mountPath || typeof body.mountPath !== 'string') {
    return errorJson('mountPath must be a non-empty string', 'invalid_request', 400);
  }
  if (!body.mountPath.startsWith('/')) {
    return errorJson('mountPath must be an absolute path (start with /)', 'invalid_request', 400);
  }

  // Normalize to resolve '..' / '.' segments, then reject the filesystem
  // root so the post-unmount rm -rf cleanup cannot be destructive.
  const normalizedPath = new URL(body.mountPath, 'file:///').pathname;
  if (normalizedPath === '/') {
    return errorJson('mountPath must not resolve to / (filesystem root)', 'invalid_request', 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

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
// DELETE /sandbox/:id
//
// Best-effort shutdown of the sandbox instance.
// The Durable Object will eventually be garbage-collected by Cloudflare;
// this call just tries to terminate the underlying container early.
//
// Response: {"ok": true} always (errors are swallowed — best-effort)
// ------------------------------------------------------------------

app.delete('/v1/sandbox/:id', async (c) => {
  const sandbox = getSandbox(c.env.Sandbox, c.get('containerUUID'));

  try {
    // The CF sandbox SDK does not expose an explicit destroy() on the client
    // stub; calling exec('true') just to wake it and let the DO handle
    // cleanup is sufficient.  If the sandbox is already dead this is a no-op.
    await sandbox.exec('true');
  } catch {
    // Intentionally swallow — best-effort.
  }

  return c.json({ ok: true });
});

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------

app.get('/health', (c) => c.json({ ok: true }));

// ------------------------------------------------------------------
// Pool management routes
// ------------------------------------------------------------------

app.use('/v1/pool/*', async (c, next) => {
  const token = c.env.SANDBOX_API_KEY;
  if (token) {
    const authHeader = c.req.header('Authorization') ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (provided !== token) {
      return errorJson('Unauthorized', 'unauthorized', 401);
    }
  } else {
    console.warn(
      '[security] SANDBOX_API_KEY is not set — auth is disabled. Set via `wrangler secret put SANDBOX_API_KEY`.'
    );
  }
  return next();
});

app.get('/v1/pool/stats', async (c) => {
  const warmTarget = Number.parseInt(c.env.WARM_POOL_TARGET || '0', 10) || 0;
  const refreshInterval = Number.parseInt(c.env.WARM_POOL_REFRESH_INTERVAL || '10000', 10) || 10_000;

  const poolId = c.env.WARM_POOL.idFromName('global-pool');
  const poolStub = c.env.WARM_POOL.get(poolId);

  try {
    await poolStub.configure({ warmTarget, refreshInterval });
  } catch {
    // Continue — stats should still be readable even if config push fails.
  }

  const stats = await poolStub.getStats();
  return c.json(stats);
});

app.post('/v1/pool/shutdown-prewarmed', async (c) => {
  const warmTarget = Number.parseInt(c.env.WARM_POOL_TARGET || '0', 10) || 0;
  const refreshInterval = Number.parseInt(c.env.WARM_POOL_REFRESH_INTERVAL || '10000', 10) || 10_000;

  const poolId = c.env.WARM_POOL.idFromName('global-pool');
  const poolStub = c.env.WARM_POOL.get(poolId);

  try {
    await poolStub.configure({ warmTarget, refreshInterval });
  } catch {
    // Continue.
  }

  await poolStub.shutdownPrewarmed();
  return c.json({ ok: true });
});

app.post('/v1/pool/prime', async (c) => {
  await primePool(c.env);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------
// OpenAPI routes
// GET /openapi.json
//
// GET /openapi.json  — machine-readable OpenAPI 3.1 schema
// GET /openapi.html  — interactive HTML documentation
// GET /openapi       — alias for /openapi.html
//
// All three accept auth via Bearer header or ?token= query parameter.
// Schema is defined in ./openapi.ts and imported above.
// ------------------------------------------------------------------

const openapiAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = c.env.SANDBOX_API_KEY;
  if (token) {
    const authHeader = c.req.header('Authorization') ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    // Also accept the API key as a ?token= query parameter so browsers
    // and tools can load the spec without custom headers.
    const queryToken = c.req.query('token') ?? '';
    if (provided !== token && queryToken !== token) {
      return errorJson('Unauthorized', 'unauthorized', 401);
    }
  } else {
    console.warn(
      '[security] SANDBOX_API_KEY is not set — auth is disabled. Set via `wrangler secret put SANDBOX_API_KEY`.'
    );
  }
  return next();
};

const openapiHtmlHandler = () =>
  new Response(renderOpenApiHtml(OPENAPI_SCHEMA as Record<string, unknown>), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });

app.get('/v1/openapi.json', openapiAuth, (c) => c.json(OPENAPI_SCHEMA));
app.get('/v1/openapi.html', openapiAuth, openapiHtmlHandler);
app.get('/v1/openapi', openapiAuth, openapiHtmlHandler);

// ------------------------------------------------------------------
// Worker entry point
// ------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper — prime the warm pool (shared by POST /pool/prime and cron trigger)
// ---------------------------------------------------------------------------

async function primePool(env: Env): Promise<void> {
  const warmTarget = Number.parseInt(env.WARM_POOL_TARGET || '0', 10) || 0;
  const refreshInterval = Number.parseInt(env.WARM_POOL_REFRESH_INTERVAL || '10000', 10) || 10_000;

  const poolId = env.WARM_POOL.idFromName('global-pool');
  const poolStub = env.WARM_POOL.get(poolId);
  await poolStub.configure({ warmTarget, refreshInterval });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Let the Cloudflare sandbox SDK handle preview-URL proxy routing first.
    // This enables `sandbox.exposePort()` and in-browser port access.
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    return app.fetch(request, env, ctx);
  },

  /**
   * Cron trigger — primes the warm pool so the alarm loop starts and
   * containers are pre-warmed even without any HTTP traffic.
   * Configure in wrangler.jsonc under triggers.crons.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await primePool(env);
  }
};
