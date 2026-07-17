import { errorJson, resolveWorkspacePath, sseToByteStream } from '../helpers';
import type { WriteResponse } from '../types';
import { type BridgeApp, getSandbox, getSandboxNs } from './common';

export function registerFileRoutes(
  app: BridgeApp,
  apiPrefix: string,
  sandboxBinding: string
): void {
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

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    try {
      const stream = await sandbox.readFileStream(resolvedPath);
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

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
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
      await sandbox.writeFile(resolvedPath, b64, { encoding: 'base64' });
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
}
