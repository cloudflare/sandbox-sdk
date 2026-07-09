import type { ProcessLogEvent } from '@repo/shared';
import { validatePort } from '../../security';
import { errorJson, resolveWorkspacePath } from '../helpers';
import type { ExecRequest, RunningResponse } from '../types';
import {
  type BridgeApp,
  getSandbox,
  getSandboxNs,
  parseTunnelOptions
} from './common';

export function registerProcessRoutes(
  app: BridgeApp,
  apiPrefix: string,
  sandboxBinding: string
): void {
  // ------------------------------------------------------------------
  // /sandbox/:id/processes
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/processes`, async (c) => {
    const body = await parseProcessRequest(c.req.raw);
    if (body instanceof Response) return body;

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    const options = processOptions(body);
    if (options instanceof Response) return options;

    try {
      const process = await sandbox.exec(body.argv, options);
      return c.json(await process.status());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`process launch failed: ${msg}`, 'process_error', 502);
    }
  });

  app.get(`${apiPrefix}/sandbox/:id/processes`, async (c) => {
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    return c.json(await sandbox.listProcesses());
  });

  app.get(`${apiPrefix}/sandbox/:id/processes/:processId`, async (c) => {
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    const process = await sandbox.getProcess(c.req.param('processId'));
    if (!process) return errorJson('Process not found', 'not_found', 404);
    return c.json(await process.status());
  });

  app.get(`${apiPrefix}/sandbox/:id/processes/:processId/logs`, async (c) => {
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    const process = await sandbox.getProcess(c.req.param('processId'));
    if (!process) return errorJson('Process not found', 'not_found', 404);

    const replay = parseBoolean(c.req.query('replay'));
    const follow = parseBoolean(c.req.query('follow'));
    const logs = await process.logs({
      since: c.req.query('since'),
      replay,
      follow
    });
    return new Response(processLogsToSSE(logs), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    });
  });

  app.post(`${apiPrefix}/sandbox/:id/processes/:processId/kill`, async (c) => {
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    const process = await sandbox.getProcess(c.req.param('processId'));
    if (!process) return errorJson('Process not found', 'not_found', 404);
    const signal = await parseKillRequest(c.req.raw);
    if (signal instanceof Response) return signal;
    await process.kill(signal);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------
  // POST /sandbox/:id/tunnel/:port
  // DELETE /sandbox/:id/tunnel/:port
  // ------------------------------------------------------------------

  app.post(`${apiPrefix}/sandbox/:id/tunnel/:port`, async (c) => {
    const port = Number(c.req.param('port'));
    if (!validatePort(port)) {
      return errorJson('Invalid port', 'invalid_request', 400);
    }

    const options = parseTunnelOptions(await c.req.text());
    if (options instanceof Response) return options;

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );

    try {
      const tunnel = await sandbox.tunnels.get(port, options);
      return c.json(tunnel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`tunnel failed: ${msg}`, 'tunnel_error', 502);
    }
  });

  app.delete(`${apiPrefix}/sandbox/:id/tunnel/:port`, async (c) => {
    const port = Number(c.req.param('port'));
    if (!validatePort(port)) {
      return errorJson('Invalid port', 'invalid_request', 400);
    }

    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );

    try {
      await sandbox.tunnels.destroy(port);
      return c.body(null, 204);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`tunnel failed: ${msg}`, 'tunnel_error', 502);
    }
  });

  // ------------------------------------------------------------------
  // GET /sandbox/:id/running
  // ------------------------------------------------------------------

  app.get(`${apiPrefix}/sandbox/:id/running`, async (c) => {
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );

    try {
      const running = await sandbox.isRuntimeActive();
      const response: RunningResponse = { running };
      return c.json(response);
    } catch {
      const response: RunningResponse = { running: false };
      return c.json(response);
    }
  });
}

async function parseProcessRequest(
  request: Request
): Promise<ExecRequest | Response> {
  let body: ExecRequest;
  try {
    body = await request.json<ExecRequest>();
  } catch {
    return errorJson('Invalid JSON body', 'invalid_request', 400);
  }
  if (!Array.isArray(body.argv) || body.argv.length === 0) {
    return errorJson('argv must be a non-empty array', 'invalid_request', 400);
  }
  if (body.argv.some((item) => typeof item !== 'string')) {
    return errorJson('argv items must be strings', 'invalid_request', 400);
  }
  if (body.argv[0].length === 0) {
    return errorJson(
      'argv executable must be non-empty',
      'invalid_request',
      400
    );
  }
  return body;
}

function processOptions(
  body: ExecRequest
): { timeout?: number; cwd?: string; env?: Record<string, string> } | Response {
  const options: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  } = {};
  if (body.timeout !== undefined) {
    if (
      typeof body.timeout !== 'number' ||
      !Number.isFinite(body.timeout) ||
      body.timeout <= 0
    ) {
      return errorJson(
        'timeout must be a positive finite number',
        'invalid_request',
        400
      );
    }
    options.timeout = body.timeout;
  }
  if (typeof body.cwd === 'string') {
    const cwd = resolveWorkspacePath(body.cwd);
    if (!cwd) {
      return errorJson(
        'cwd must resolve to a location within /workspace',
        'invalid_request',
        403
      );
    }
    options.cwd = cwd;
  }
  if ('env' in body && body.env !== undefined) {
    if (!isStringRecord(body.env)) {
      return errorJson(
        'env must be an object of strings',
        'invalid_request',
        400
      );
    }
    options.env = body.env;
  }
  return options;
}

async function parseKillRequest(request: Request): Promise<number | Response> {
  if (!request.headers.get('content-type')) return 15;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson('Invalid JSON body', 'invalid_request', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorJson('Request body must be an object', 'invalid_request', 400);
  }
  const signal = (body as { signal?: unknown }).signal;
  if (signal === undefined) return 15;
  if (
    typeof signal !== 'number' ||
    !Number.isInteger(signal) ||
    signal < 1 ||
    signal > 64
  ) {
    return errorJson(
      'signal must be an integer between 1 and 64',
      'invalid_request',
      400
    );
  }
  return signal;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true' || value === '1';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function processLogsToSSE(
  logs: ReadableStream<ProcessLogEvent>
): ReadableStream<Uint8Array> {
  const reader = logs.getReader();
  const encoder = new TextEncoder();
  let finished = false;

  async function finish(cancelSource: boolean): Promise<void> {
    if (finished) return;
    finished = true;
    if (cancelSource) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            await finish(false);
            controller.close();
            return;
          }
          const event = result.value;
          const data =
            event.type === 'stdout' || event.type === 'stderr'
              ? {
                  type: event.type,
                  cursor: event.cursor,
                  timestamp: event.timestamp,
                  data: bytesToBase64(event.data)
                }
              : event;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch (error) {
          await finish(true);
          controller.error(error);
        }
      },
      async cancel() {
        await finish(true);
      }
    },
    { highWaterMark: 0 }
  );
}

function bytesToBase64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}
