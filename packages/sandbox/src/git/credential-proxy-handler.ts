import type {
  OutboundHandler,
  OutboundHandlerContext
} from '@cloudflare/containers';
import type { GitAuthInterceptorParams, GitHostAuth } from './types.js';

function encodeBasicAuth(username: string, token: string): string {
  return btoa(`${username}:${token}`);
}

function authorizationHeader(auth: GitHostAuth): string {
  if (auth.type === 'bearer') {
    return `Bearer ${auth.token}`;
  }
  return `Basic ${encodeBasicAuth(auth.username ?? 'x-access-token', auth.token)}`;
}

export const gitCredentialProxyHandler: OutboundHandler<
  Cloudflare.Env,
  GitAuthInterceptorParams
> = async (
  request: Request,
  _env: Cloudflare.Env,
  ctx: OutboundHandlerContext<GitAuthInterceptorParams>
): Promise<Response> => {
  const url = new URL(request.url);
  const auth = ctx.params?.hosts[url.hostname];
  if (!auth) {
    return fetch(request);
  }

  const headers = new Headers(request.headers);
  if (!headers.has('authorization')) {
    headers.set('authorization', authorizationHeader(auth));
  }

  return fetch(new Request(request, { headers }));
};
