import {
  ProxyError,
  ProxyPathInvalidError,
  ProxyServiceNotFoundError,
  ProxyTargetError,
  ProxyTokenMissingError
} from './errors';
import { verifyProxyToken } from './token';
import type {
  ProxyContext,
  ProxyHandler,
  ProxyHandlerConfig,
  ServiceConfig
} from './types';

function parseProxyPath(
  pathname: string,
  mountPath: string
): { service: string; path: string } {
  const normalizedMount = `/${mountPath.replace(/^\/|\/$/g, '')}`;

  if (!pathname.startsWith(normalizedMount)) {
    throw new ProxyPathInvalidError(pathname, normalizedMount);
  }

  const afterMount = pathname.slice(normalizedMount.length);

  if (!afterMount.startsWith('/') || afterMount === '/') {
    throw new ProxyPathInvalidError(pathname, normalizedMount);
  }

  const parts = afterMount.slice(1).split('/');
  const service = parts[0];
  const path = `/${parts.slice(1).join('/')}`;

  if (!service) {
    throw new ProxyPathInvalidError(pathname, normalizedMount);
  }

  return { service, path };
}

function buildTargetUrl(targetBase: string, path: string, query: string): URL {
  const base = targetBase.replace(/\/$/, '');
  const url = new URL(path, `${base}/`);
  url.search = query;
  return url;
}

function errorResponse(error: ProxyError): Response {
  return new Response(
    JSON.stringify({ error: error.message, code: error.code }),
    {
      status: error.httpStatus,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

export function createProxyHandler<Env = unknown>(
  config: ProxyHandlerConfig<Env>
): ProxyHandler<Env> {
  const { mountPath, jwtSecret, services } = config;
  const serviceNames = Object.keys(services);

  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);

    try {
      const { service, path } = parseProxyPath(url.pathname, mountPath);

      const serviceConfig = services[service] as ServiceConfig<Env> | undefined;
      if (!serviceConfig) {
        throw new ProxyServiceNotFoundError(service, serviceNames);
      }

      const token = await serviceConfig.validate(request);
      if (!token) {
        throw new ProxyTokenMissingError(service);
      }

      const jwt = await verifyProxyToken({ secret: jwtSecret(env), token });

      const targetUrl = buildTargetUrl(serviceConfig.target, path, url.search);

      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: new Headers(request.headers),
        body: request.body,
        redirect: 'manual'
      });

      const ctx: ProxyContext<Env> = { jwt, env, service, request };
      const result = await serviceConfig.transform(proxyRequest, ctx);

      if (result instanceof Response) {
        return result;
      }

      const response = await fetch(result);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      if (error instanceof ProxyError) {
        return errorResponse(error);
      }

      if (error instanceof TypeError && error.message.includes('fetch')) {
        return errorResponse(new ProxyTargetError('unknown', 'unknown', error));
      }

      throw error;
    }
  };
}
