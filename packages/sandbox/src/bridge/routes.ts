import { Hono, type MiddlewareHandler } from 'hono';
import type { Sandbox } from '../sandbox';
import { errorJson } from './helpers';
import { OPENAPI_SCHEMA } from './openapi';
import { renderOpenApiHtml } from './openapi-html';
import { getWarmPoolStub } from './routes/common';
import { registerFileRoutes } from './routes/files';
import { registerLifecycleRoutes } from './routes/lifecycle';
import { registerProcessRoutes } from './routes/processes';
import { registerTerminalRoutes } from './routes/terminals';
import type { BridgeEnv } from './types';

export interface RouteConfig {
  sandboxBinding: string;
  warmPoolBinding: string;
  apiPrefix: string;
  healthPath: string;
}

type SandboxRoutePoolMode = 'allocate' | 'lookup' | 'unmatched';

function sandboxRoutePoolMode(
  method: string,
  routePath: string
): SandboxRoutePoolMode {
  if (method === 'GET' && routePath === '/running') return 'lookup';
  if (
    method === 'GET' &&
    (routePath === '/processes' ||
      /^\/processes\/[^/]+(?:\/logs)?$/.test(routePath))
  ) {
    return 'lookup';
  }
  if (method === 'POST' && /^\/processes\/[^/]+\/kill$/.test(routePath)) {
    return 'lookup';
  }
  if (
    method === 'GET' &&
    (routePath === '/terminals' ||
      /^\/terminals\/[^/]+(?:\/connect)?$/.test(routePath))
  ) {
    return 'lookup';
  }
  if (
    method === 'POST' &&
    /^\/terminals\/[^/]+\/(interrupt|terminate)$/.test(routePath)
  ) {
    return 'lookup';
  }

  if (
    method === 'POST' &&
    [
      '/processes',
      '/terminals',
      '/persist',
      '/hydrate',
      '/mount',
      '/unmount'
    ].includes(routePath)
  ) {
    return 'allocate';
  }
  if (
    (method === 'GET' || method === 'PUT') &&
    routePath.startsWith('/file/')
  ) {
    return 'allocate';
  }
  if (
    (method === 'POST' || method === 'DELETE') &&
    /^\/tunnel\/[^/]+$/.test(routePath)
  ) {
    return 'allocate';
  }
  return 'unmatched';
}

function missingRuntimeResponse(routePath: string): Response {
  if (routePath === '/running') {
    return Response.json({ running: false });
  }
  if (routePath === '/processes' || routePath === '/terminals') {
    return Response.json([]);
  }
  if (routePath.startsWith('/terminals/')) {
    return errorJson('Terminal not found', 'not_found', 404);
  }
  return errorJson('Process not found', 'not_found', 404);
}

export function createBridgeApp(
  config: RouteConfig
): Hono<{ Bindings: BridgeEnv; Variables: { containerUUID: string } }> {
  const app = new Hono<{
    Bindings: BridgeEnv;
    Variables: { containerUUID: string };
  }>();

  const { sandboxBinding, warmPoolBinding, apiPrefix } = config;

  app.use(`${apiPrefix}/sandbox/*`, async (c, next) => {
    const url = new URL(c.req.url);
    const pathParts = url.pathname.split('/');
    const prefixParts = apiPrefix.split('/').filter(Boolean);
    const sandboxId = pathParts[prefixParts.length + 2];
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

  app.use(`${apiPrefix}/sandbox/:id/*`, async (c, next) => {
    const url = new URL(c.req.url);
    const sandboxId = c.req.param('id');
    const routePath = url.pathname.slice(
      `${apiPrefix}/sandbox/${sandboxId}`.length
    );
    const poolMode = sandboxRoutePoolMode(c.req.method, routePath);
    if (poolMode === 'unmatched') return next();

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
      const containerUUID =
        poolMode === 'lookup'
          ? await poolStub.lookupContainer(sandboxId)
          : await poolStub.getContainer(sandboxId);
      if (!containerUUID) return missingRuntimeResponse(routePath);
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

  app.use(`${apiPrefix}/sandbox/:id`, async (c, next) => {
    if (c.req.method !== 'DELETE') return next();

    const sandboxId = c.req.param('id');
    const poolStub = getWarmPoolStub(c.env, warmPoolBinding);

    try {
      const containerUUID = await poolStub.lookupContainer(sandboxId);
      if (!containerUUID) {
        return new Response(null, { status: 204 });
      }
      c.set('containerUUID', containerUUID);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorJson(`pool error: ${msg}`, 'pool_error', 502);
    }

    return next();
  });

  registerLifecycleRoutes(
    app,
    apiPrefix,
    config.healthPath,
    sandboxBinding,
    warmPoolBinding
  );
  registerProcessRoutes(app, apiPrefix, sandboxBinding);
  registerFileRoutes(app, apiPrefix, sandboxBinding);
  registerTerminalRoutes(app, apiPrefix, sandboxBinding);
  registerOpenApiRoutes(app, apiPrefix);

  return app;
}

function registerOpenApiRoutes(
  app: Hono<{ Bindings: BridgeEnv; Variables: { containerUUID: string } }>,
  apiPrefix: string
): void {
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
}
