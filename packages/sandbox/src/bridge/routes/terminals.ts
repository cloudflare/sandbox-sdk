import type { CreateTerminalOptions, SandboxCommand } from '@repo/shared';
import { errorJson, validateTerminalId } from '../helpers';
import { type BridgeApp, getSandbox, getSandboxNs } from './common';

function parsePositiveInteger(
  value: string | undefined,
  name: string
): number | Response | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return errorJson(
      `${name} must be a positive integer`,
      'invalid_request',
      400
    );
  }
  return parsed;
}

function isSandboxCommand(value: unknown): value is SandboxCommand {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string')
  );
}

function parseCreateTerminalBody(
  rawBody: string
): CreateTerminalOptions | Response {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorJson('Invalid JSON body', 'invalid_request', 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorJson('Request body must be an object', 'invalid_request', 400);
  }

  const record = body as Record<string, unknown>;
  const argv = record.argv;
  if (!isSandboxCommand(argv)) {
    return errorJson(
      'argv must be a non-empty string array',
      'invalid_request',
      400
    );
  }

  const options: CreateTerminalOptions = { command: argv };
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string')
      return errorJson('cwd must be a string', 'invalid_request', 400);
    options.cwd = record.cwd;
  }
  if (record.env !== undefined) {
    if (
      !record.env ||
      typeof record.env !== 'object' ||
      Array.isArray(record.env)
    ) {
      return errorJson('env must be an object', 'invalid_request', 400);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.env)) {
      if (typeof value !== 'string')
        return errorJson('env values must be strings', 'invalid_request', 400);
      env[key] = value;
    }
    options.env = env;
  }
  if (record.cols !== undefined) {
    if (
      typeof record.cols !== 'number' ||
      !Number.isInteger(record.cols) ||
      record.cols <= 0
    )
      return errorJson(
        'cols must be a positive integer',
        'invalid_request',
        400
      );
    options.cols = record.cols;
  }
  if (record.rows !== undefined) {
    if (
      typeof record.rows !== 'number' ||
      !Number.isInteger(record.rows) ||
      record.rows <= 0
    )
      return errorJson(
        'rows must be a positive integer',
        'invalid_request',
        400
      );
    options.rows = record.rows;
  }
  return options;
}

function terminalError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return errorJson(`terminal failed: ${message}`, 'exec_transport_error', 502);
}

export function registerTerminalRoutes(
  app: BridgeApp,
  apiPrefix: string,
  sandboxBinding: string
): void {
  app.post(`${apiPrefix}/sandbox/:id/terminals`, async (c) => {
    const parsed = parseCreateTerminalBody(await c.req.text());
    if (parsed instanceof Response) return parsed;
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    try {
      const terminal = await sandbox.createTerminal(parsed);
      return c.json(await terminal.getSnapshot());
    } catch (error) {
      return terminalError(error);
    }
  });

  app.get(`${apiPrefix}/sandbox/:id/terminals`, async (c) => {
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    try {
      const terminals = await sandbox.listTerminals();
      return c.json(
        await Promise.all(terminals.map((terminal) => terminal.getSnapshot()))
      );
    } catch (error) {
      return terminalError(error);
    }
  });

  app.get(`${apiPrefix}/sandbox/:id/terminals/:terminalId`, async (c) => {
    const terminalId = validateTerminalId(c.req.param('terminalId'));
    if (!terminalId)
      return errorJson('Invalid terminal ID format', 'invalid_request', 400);
    const sandbox = getSandbox(
      getSandboxNs(c.env, sandboxBinding),
      c.get('containerUUID')
    );
    try {
      const terminal = await sandbox.getTerminal(terminalId);
      if (!terminal) return errorJson('Terminal not found', 'not_found', 404);
      return c.json(await terminal.getSnapshot());
    } catch (error) {
      return terminalError(error);
    }
  });

  app.get(
    `${apiPrefix}/sandbox/:id/terminals/:terminalId/connect`,
    async (c) => {
      const upgrade = c.req.header('Upgrade');
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return errorJson('WebSocket upgrade required', 'invalid_request', 400);
      }
      const terminalId = validateTerminalId(c.req.param('terminalId'));
      if (!terminalId)
        return errorJson('Invalid terminal ID format', 'invalid_request', 400);
      const cols = parsePositiveInteger(c.req.query('cols'), 'cols');
      if (cols instanceof Response) return cols;
      const rows = parsePositiveInteger(c.req.query('rows'), 'rows');
      if (rows instanceof Response) return rows;
      const sandbox = getSandbox(
        getSandboxNs(c.env, sandboxBinding),
        c.get('containerUUID')
      );
      try {
        const terminal = await sandbox.getTerminal(terminalId);
        if (!terminal) return errorJson('Terminal not found', 'not_found', 404);
        return await terminal.connect(c.req.raw, {
          cursor: c.req.query('cursor'),
          cols,
          rows
        });
      } catch (error) {
        return terminalError(error);
      }
    }
  );

  app.post(
    `${apiPrefix}/sandbox/:id/terminals/:terminalId/interrupt`,
    async (c) => {
      const terminalId = validateTerminalId(c.req.param('terminalId'));
      if (!terminalId)
        return errorJson('Invalid terminal ID format', 'invalid_request', 400);
      const sandbox = getSandbox(
        getSandboxNs(c.env, sandboxBinding),
        c.get('containerUUID')
      );
      try {
        const terminal = await sandbox.getTerminal(terminalId);
        if (!terminal) return errorJson('Terminal not found', 'not_found', 404);
        await terminal.interrupt();
        return new Response(null, { status: 204 });
      } catch (error) {
        return terminalError(error);
      }
    }
  );

  app.post(
    `${apiPrefix}/sandbox/:id/terminals/:terminalId/terminate`,
    async (c) => {
      const terminalId = validateTerminalId(c.req.param('terminalId'));
      if (!terminalId)
        return errorJson('Invalid terminal ID format', 'invalid_request', 400);
      const sandbox = getSandbox(
        getSandboxNs(c.env, sandboxBinding),
        c.get('containerUUID')
      );
      try {
        const terminal = await sandbox.getTerminal(terminalId);
        if (!terminal) return errorJson('Terminal not found', 'not_found', 404);
        await terminal.terminate();
        return new Response(null, { status: 204 });
      } catch (error) {
        return terminalError(error);
      }
    }
  );
}
