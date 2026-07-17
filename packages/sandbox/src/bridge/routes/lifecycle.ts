import {
  base32Encode,
  errorJson,
  sseToByteStream,
  withStreamCleanup
} from '../helpers';
import { primePool } from '../pool';
import type { MountBucketRequest, UnmountBucketRequest } from '../types';
import {
  type BridgeApp,
  getSandbox,
  getSandboxNs,
  getWarmPoolStub,
  resolveMountBucketName,
  toSDKMountOptions,
  validateMountOptions
} from './common';

export function registerLifecycleRoutes(
  app: BridgeApp,
  apiPrefix: string,
  healthPath: string,
  sandboxBinding: string,
  warmPoolBinding: string
): void {
  // ------------------------------------------------------------------
  // POST /sandbox
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox`, (c) => {
    const bytes = new Uint8Array(15);
    crypto.getRandomValues(bytes);
    return c.json({ id: base32Encode(bytes) });
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

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );

    try {
      const archivePath = await sandbox.createWorkspaceArchive({
        root,
        excludes
      });
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await sandbox.readFileStream(archivePath);
      } catch (error) {
        await sandbox
          .cleanupWorkspaceArchive(archivePath)
          .catch(() => undefined);
        throw error;
      }

      const cleanupPath = archivePath;
      const responseStream = withStreamCleanup(sseToByteStream(stream), () =>
        sandbox.cleanupWorkspaceArchive(cleanupPath)
      );
      return new Response(responseStream, {
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

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );

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

    const tmpPath = `/tmp/sandbox-hydrate-${Date.now()}-${crypto.randomUUID()}.tar`;
    try {
      let b64 = '';
      const CHUNK = 6144; // 6144 = 3 * 2048 — no intermediate padding
      for (let i = 0; i < tarBytes.length; i += CHUNK) {
        b64 += btoa(String.fromCharCode(...tarBytes.subarray(i, i + CHUNK)));
      }
      await sandbox.writeFile(tmpPath, b64, { encoding: 'base64' });

      await sandbox.extractWorkspaceArchive({ root, archivePath: tmpPath });

      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(
        `hydrate failed: ${msg}`,
        'workspace_archive_write_error',
        502
      );
    } finally {
      await sandbox.cleanupWorkspaceArchive(tmpPath).catch(() => undefined);
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

    if (
      body.bucket !== undefined &&
      (typeof body.bucket !== 'string' || body.bucket === '')
    ) {
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
    if (
      !body.options ||
      typeof body.options !== 'object' ||
      Array.isArray(body.options)
    ) {
      return errorJson('options must be an object', 'invalid_request', 400);
    }
    const optionsError = validateMountOptions(body.options, body.binding);
    if (optionsError) return optionsError;
    const bucketName = resolveMountBucketName(body);
    if (bucketName instanceof Response) return bucketName;

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    const sdkOptions = toSDKMountOptions(body.options);

    try {
      await sandbox.mountBucket(bucketName, body.mountPath, sdkOptions);
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

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );

    try {
      await sandbox.unmountBucket(normalizedPath);

      try {
        await sandbox.cleanupMountDirectory(normalizedPath);
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
  // ------------------------------------------------------------------

  app.delete(`${apiPrefix}/sandbox/:id`, async (c) => {
    const containerUUID = c.get('containerUUID');
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      containerUUID
    );

    try {
      await sandbox.destroy();
    } catch {
      // Best-effort — container may already be gone
    }

    // Release the WarmPool assignment so it doesn't track a dead container
    try {
      const poolStub = getWarmPoolStub(c.env, warmPoolBinding);
      await poolStub.reportStopped(containerUUID);
    } catch {
      // Best-effort
    }

    return new Response(null, { status: 204 });
  });

  // ------------------------------------------------------------------
  // Health check
  // ------------------------------------------------------------------

  app.get(healthPath, (c) => {
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

    const poolStub = getWarmPoolStub(c.env, warmPoolBinding);

    try {
      await poolStub.configure({ warmTarget, refreshInterval });
    } catch {
      // Continue — stats should still be readable even if config push fails.
    }

    const stats = await poolStub.getStats();
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

    const poolStub = getWarmPoolStub(c.env, warmPoolBinding);

    try {
      await poolStub.configure({ warmTarget, refreshInterval });
    } catch {
      // Continue.
    }

    await poolStub.shutdownPrewarmed();
    return c.json({ ok: true });
  });

  app.post(`${apiPrefix}/pool/prime`, async (c) => {
    await primePool(c.env, warmPoolBinding);
    return c.json({ ok: true });
  });
}
